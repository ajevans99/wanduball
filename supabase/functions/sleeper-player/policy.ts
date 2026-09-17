export const liveRoomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
export const liveLeagueId = "1389331555339468800";
export type Assignment = {
  id: string; season: number; week: number; dropped: boolean;
  player: { id: string; position: string }; manager: { id: string };
};
export type Roster = { league_id: string; roster_id: number; players: string[] | null; reserve?: string[] | null; taxi?: string[] | null };
export function rosterStatus(a: Assignment, rosters: Roster[], claimed: boolean, current: boolean) {
  if (!/^[1-9]\d{0,9}$/.test(a.player.id) || !/^[1-9]\d{0,3}$/.test(a.manager.id))
    return { status: "ineligible", canApply: false };
  const target = rosters.find(r => String(r.roster_id) === a.manager.id);
  if (!target) return { status: "invalid-roster", canApply: false };
  const owners = rosters.filter(r => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])].includes(a.player.id));
  if (owners.some(r => r !== target)) return { status: "conflict", canApply: false };
  if (owners.includes(target)) return { status: "applied", canApply: false };
  if (a.dropped) return { status: "dropped", canApply: false };
  if (claimed) return { status: "verification-required", canApply: false };
  if (!current || a.season !== 2026 || a.week < 2 || !["QB", "RB", "WR"].includes(a.player.position))
    return { status: "ineligible", canApply: false };
  return { status: "absent", canApply: true };
}
export function parseRosters(value: unknown): Roster[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Roster data unavailable");
  const ids = new Set<number>();
  for (const r of value) {
    if (!r || String(r.league_id) !== liveLeagueId || !Number.isSafeInteger(r.roster_id) || r.roster_id < 1 || ids.has(r.roster_id))
      throw new Error("Invalid roster response");
    for (const key of ["players", "reserve", "taxi"]) {
      if (r[key] !== null && (!Array.isArray(r[key]) || !r[key].every((id: unknown) => typeof id === "string")))
        throw new Error("Invalid player membership response");
    }
    ids.add(r.roster_id);
  }
  return value;
}
