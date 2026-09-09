import { z } from "zod";
import { positions, type Player, type Position } from "../game";
import { HttpError } from "./http";

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

export const sleeperQuerySchema = z.object({
  leagueId: z.string().regex(/^\d{1,30}$/),
  season: z.coerce.number().int().min(2020).max(2100),
  week: z.coerce.number().int().min(1).max(18),
  statsSeason: z.coerce.number().int().min(2020).max(2100).optional(),
  ranking: z.enum(["ppr", "half_ppr", "std", "league"]).default("ppr"),
});

async function upstream<T>(path: string, schema: z.ZodType<T>, revalidate = 300): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.sleeper.app/v1/${path}`, {
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

export async function importSleeper(query: z.infer<typeof sleeperQuerySchema>) {
  const { leagueId, season, week, ranking } = query;
  const statsSeason = query.statsSeason ?? season;
  if (ranking === "league") {
    throw new HttpError(400, "League-scoring rankings are not supported yet. Choose ppr, half_ppr, or std; league scoring baselines are still imported.");
  }
  if (statsSeason > season) throw new HttpError(400, "The statistics season cannot be later than the selected game season.");
  if (statsSeason === season && week === 1) {
    throw new HttpError(422, `Week 1 has no completed weeks for ${season}. Explicitly choose statsSeason=${season - 1} to rank using previous-season totals.`);
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
  const liveSeason = Number(nfl.season);
  if (!Number.isInteger(liveSeason) || !["pre", "regular", "post", "off"].includes(nfl.season_type)) {
    throw new HttpError(502, "Sleeper's current NFL season could not be verified.");
  }
  if (statsSeason > liveSeason
    || (statsSeason === liveSeason && (
      (statsSeason < season && !["post", "off"].includes(nfl.season_type))
      || (statsSeason === season && !["post", "off"].includes(nfl.season_type)
        && (nfl.season_type !== "regular" || week > nfl.week))
    ))) {
    throw new HttpError(422, "That ranking period includes unfinished or future NFL weeks. Select a completed period or an earlier statistics season.");
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
  const paths = statsSeason < season
    ? [`stats/nfl/regular/${statsSeason}`]
    : Array.from({ length: week - 1 }, (_, i) => `stats/nfl/regular/${statsSeason}/${i + 1}`);
  const [dictionary, periods] = await Promise.all([
    nflPlayers(),
    Promise.all(paths.map(path => upstream(path, statsSchema, 3600))),
  ]);
  const totals = new Map<string, number>();
  for (const stats of periods) {
    if (!Object.values(stats).some(value => (value?.[scoreKey] ?? 0) > 0)) {
      throw new HttpError(422, "Sleeper has no positive fantasy statistics for at least one requested period. Choose a completed statistics season/week; no synthetic scores were used.");
    }
    for (const [id, values] of Object.entries(stats)) {
      const points = values?.[scoreKey];
      if (typeof points === "number") totals.set(id, (totals.get(id) ?? 0) + points);
    }
  }
  const candidates: Player[] = [];
  for (const [id, points] of totals) {
    const player = dictionary[id];
    if (!player || !positions.includes(player.position as Position) || !Number.isFinite(points) || points <= 0) continue;
    const name = player.full_name?.trim() || [player.first_name, player.last_name].filter(Boolean).join(" ").trim();
    if (!name) continue;
    candidates.push({
      id, name, points: Math.round(points * 100) / 100,
      position: player.position as Position,
      team: player.team ?? "FA", injury: player.injury_status ?? null,
    });
  }
  const players = positions.flatMap(position => candidates.filter(p => p.position === position)
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, 30));
  if (positions.some(position => players.filter(player => player.position === position).length < 10)) {
    throw new HttpError(422, "Sleeper returned fewer than 10 positive-scoring players at one or more positions. Select another completed ranking period.");
  }
  const label = { ppr: "PPR", half_ppr: "half-PPR", std: "standard" }[ranking];
  const period = statsSeason < season
    ? `${statsSeason} previous-season regular-season totals`
    : `${statsSeason} season-to-date, completed weeks 1–${week - 1} (before week ${week})`;
  return {
    players, managers, season, week, leagueId,
    source: `Sleeper ${label} — ${period}; setup: ${season} week ${week}. Injuries require manual review.`,
    baselines: league.scoring_settings,
  };
}
