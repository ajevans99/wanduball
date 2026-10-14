import { z } from "zod";
import { enabledPositions, positions, type Player, type Position } from "../game";
import { HttpError } from "./http";
import { leaguePoints, validateScoring } from "./sleeper-scoring";

const text = z.string().nullish();
const leagueSchema = z.object({
  league_id: z.string(),
  season: z.string(),
  sport: z.string(),
  total_rosters: z.number().int(),
  scoring_settings: z.record(z.string(), z.number().finite()).nullish(),
});
const usersSchema = z.array(z.object({
  user_id: z.string(),
  display_name: text,
  metadata: z.object({ team_name: text }).nullish(),
}));
const rostersSchema = z.array(z.object({
  roster_id: z.number().int(),
  owner_id: text,
}));
const playersSchema = z.record(z.string(), z.object({
  full_name: text,
  first_name: text,
  last_name: text,
  position: text,
  team: text,
  injury_status: text,
}).nullable());
const statsSchema = z.record(
  z.string(), z.record(z.string(), z.number().finite().nullable()).nullable(),
);
const nflSchema = z.object({
  season: z.string(),
  season_type: z.string(),
  week: z.number().int(),
});
const scheduleSchema = z.array(z.object({
  week: z.number().int().min(1).max(18),
  home: z.string().min(1),
  away: z.string().min(1),
}));

export const sleeperQuerySchema = z.object({
  leagueId: z.string().regex(/^\d{1,30}$/),
  season: z.coerce.number().int().min(2020).max(2100),
  week: z.coerce.number().int().min(1).max(18),
  statsSeason: z.coerce.number().int().min(2020).max(2100).optional(),
  statsWeek: z.never().optional(),
  ranking: z.enum(["ppr", "half_ppr", "std", "league"]).default("league"),
});

async function upstream<T>(path: string, schema: z.ZodType<T>, revalidate = 300): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.sleeper.app${path.startsWith("/") ? path : `/v1/${path}`}`, {
      next: { revalidate },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Sleeper could not be reached or timed out. Please retry; practice data will not be substituted.");
  }
  if (!response.ok) {
    if (response.status === 429) throw new HttpError(503, "Sleeper is rate limiting requests. Please wait before importing again.");
    throw new HttpError(502, `Sleeper returned HTTP ${response.status}. Check the league and statistics season, then retry.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "Sleeper returned an unreadable response. Please try again later.");
  }
  if (payload === null) throw new HttpError(404, "Sleeper did not find that league or statistics period.");
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new HttpError(502, "Sleeper returned an unexpected data format. No rankings were imported.");
  return parsed.data;
}

// The NFL dictionary can exceed Next's per-entry cache limit. Keep a bounded,
// per-process parsed copy as well; serverless cold starts still fetch it.
let playerCache: { expires: number; value: Promise<z.infer<typeof playersSchema>> } | undefined;
function nflPlayers() {
  if (!playerCache || playerCache.expires <= Date.now()) {
    const value = upstream("players/nfl", playersSchema, 86400);
    const entry = { expires: Date.now() + 86400_000, value };
    playerCache = entry;
    void value.catch(() => { if (playerCache === entry) playerCache = undefined; });
  }
  return playerCache.value;
}

async function byeTeams(season: number, week: number) {
  const seasonWeeks = season === 2020 ? 17 : 18;
  if (week > seasonWeeks) throw new HttpError(422, "The selected assignment week is outside this NFL regular season.");
  const schedule = await upstream(`/schedule/nfl/regular/${season}`, scheduleSchema, 3600);
  const weeksByTeam = new Map<string, Set<number>>();
  for (const game of schedule) {
    if (game.home === game.away || game.week > seasonWeeks) {
      throw new HttpError(502, "Sleeper returned an invalid NFL schedule. Bye weeks could not be verified; no players were imported.");
    }
    for (const team of [game.home, game.away]) {
      if (!weeksByTeam.has(team)) weeksByTeam.set(team, new Set());
      weeksByTeam.get(team)!.add(game.week);
    }
  }
  // Missing games must not turn an unpublished or partial schedule into false byes.
  if (weeksByTeam.size !== 32 || [...weeksByTeam.values()].some(weeks => weeks.size !== seasonWeeks - 1)) {
    throw new HttpError(502, "Sleeper's NFL schedule is incomplete. Bye weeks could not be verified; retry after the full schedule is published.");
  }
  return new Set([...weeksByTeam].filter(([, weeks]) => !weeks.has(week)).map(([team]) => team));
}

export async function importSleeper(query: z.infer<typeof sleeperQuerySchema>) {
  const { leagueId, season, week, ranking } = query;
  const statsSeason = query.statsSeason ?? season;
  if (statsSeason > season) throw new HttpError(400, "The statistics season cannot be later than the selected game season.");
  if (statsSeason < season && week !== 1) {
    throw new HttpError(422, "Previous-season totals are only an explicit Week 1 fallback.");
  }
  const [league, nfl] = await Promise.all([
    upstream(`league/${leagueId}`, leagueSchema),
    upstream("state/nfl", nflSchema, 60),
  ]);
  if (league.league_id !== leagueId || league.sport !== "nfl" || league.season !== String(season)) {
    throw new HttpError(422, "Choose an NFL league ID belonging to the selected game season (renewed leagues have different IDs).");
  }
  if (!league.scoring_settings || !Object.keys(league.scoring_settings).length) {
    throw new HttpError(502, "Sleeper did not return league scoring settings. Retry before importing so scoring baselines are not guessed.");
  }
  if (ranking === "league") validateScoring(league.scoring_settings);
  const liveSeason = Number(nfl.season);
  if (!Number.isInteger(liveSeason) || !["pre", "regular", "post", "off"].includes(nfl.season_type)) {
    throw new HttpError(502, "Sleeper's current NFL season could not be verified.");
  }
  if (statsSeason > liveSeason
    || (statsSeason === liveSeason && (
      (statsSeason < season && !["post", "off"].includes(nfl.season_type))
      || (statsSeason === season && !["post", "off"].includes(nfl.season_type)
        && nfl.season_type !== "regular")
    ))) {
    throw new HttpError(422, "That statistics season is in the future or unavailable. Previous-season totals are an explicit Week 1 option only.");
  }
  if (league.total_rosters !== 10) throw new HttpError(422, "Wanduball requires a Sleeper league with exactly 10 teams.");
  const [users, rosters] = await Promise.all([
    upstream(`league/${leagueId}/users`, usersSchema),
    upstream(`league/${leagueId}/rosters`, rostersSchema),
  ]);
  if (rosters.length !== 10 || rosters.some(r => !r.owner_id)
    || new Set(rosters.map(r => r.owner_id)).size !== 10
    || new Set(rosters.map(r => r.roster_id)).size !== 10) {
    throw new HttpError(422, "All 10 Sleeper teams must have distinct owners before importing.");
  }
  const managers = [...rosters].sort((a, b) => a.roster_id - b.roster_id).map(roster => {
    const user = users.find(user => user.user_id === roster.owner_id);
    if (!user) throw new HttpError(502, "Sleeper did not return a user for every team owner. Retry after completing league setup.");
    const name = user.metadata?.team_name?.trim() || user.display_name?.trim() || `Team ${roster.roster_id}`;
    return { id: String(roster.roster_id), name: name.slice(0, 100) };
  });
  const scoreKey = `pts_${ranking}`;
  const paths = [`stats/nfl/regular/${statsSeason}`];
  const [dictionary, periods, byes] = await Promise.all([
    nflPlayers(),
    Promise.all(paths.map(path => upstream(path, statsSchema, 3600))),
    byeTeams(season, week),
  ]);
  const totals = new Map<string, number>();
  for (const stats of periods) {
    if (!Object.values(stats).some(value => value && (
      (value.gp ?? 0) > 0 || ["pts_ppr", "pts_half_ppr", "pts_std"].some(key => typeof value[key] === "number")
    ))) {
      throw new HttpError(422, "Sleeper has no actual fantasy statistics for the requested season. Retry after results are published; no synthetic scores were used.");
    }
    for (const [id, values] of Object.entries(stats)) {
      const position = dictionary[id]?.position as Position;
      if (!values || !positions.includes(position)) continue;
      const points = ranking === "league" ? leaguePoints(values, league.scoring_settings, position) : values[scoreKey];
      if (typeof points === "number") totals.set(id, (totals.get(id) ?? 0) + points);
    }
  }
  const candidates: Player[] = [];
  for (const [id, points] of totals) {
    const player = dictionary[id];
    if (!player || !positions.includes(player.position as Position) || !Number.isFinite(points)) continue;
    const name = player.full_name?.trim() || [player.first_name, player.last_name].filter(Boolean).join(" ").trim();
    if (!name) continue;
    candidates.push({
      id, name, points: Math.round(points * 100) / 100,
      position: player.position as Position,
      team: player.team ?? "FA", injury: player.injury_status ?? null,
      bye: byes.has(player.team ?? ""),
    });
  }
  const players = positions.flatMap(position => candidates.filter(p => p.position === position)
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  if (enabledPositions.some(position => players.filter(player => player.position === position).length < 10)) {
    throw new HttpError(422, "Sleeper returned fewer than 10 players with statistics at one or more positions. Select another ranking period.");
  }
  const label = { ppr: "PPR", half_ppr: "half-PPR", std: "standard", league: "league scoring" }[ranking];
  const period = statsSeason < season
    ? `${statsSeason} previous-season regular-season totals`
    : `${statsSeason} cumulative regular-season actual statistics${statsSeason === liveSeason && nfl.season_type === "regular" ? " (season to date; current games may be partial)" : ""}`;
  return {
    players, managers, season, week, leagueId,
    byeTeams: [...byes],
    source: `Sleeper ${label} — ${period}; setup: ${season} week ${week}. All roster statuses; published player statistics. Out, IR and bye-week players excluded automatically; review other injuries.`,
    baselines: league.scoring_settings,
  };
}

export async function verifyPlayerAbsent(leagueId: string, playerId: string) {
  const membershipSchema = z.array(z.object({
    roster_id: z.number().int(),
    players: z.array(z.string()).nullable(),
    reserve: z.array(z.string()).nullish(),
    taxi: z.array(z.string()).nullish(),
  })).length(10);
  const rosters = await upstream(`league/${leagueId}/rosters`, membershipSchema, 0);
  if (new Set(rosters.map(r => r.roster_id)).size !== 10)
    throw new HttpError(502, "Sleeper roster membership could not be verified. No assignment was replaced.");
  if (rosters.some(r => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])].includes(playerId)))
    throw new HttpError(422, "Remove the original bye-week player from Sleeper first, then retry the replacement. No roster changes were made.");
}
