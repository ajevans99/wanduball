import { spinDurationMs, type GameState } from "./game.ts";

export const sleeperLiveRoomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
export function liveAutoEnabled(roomId: string | null, game: GameState) {
  return roomId === sleeperLiveRoomId && game.leagueId === "1389331555339468800"
    && game.season === 2026 && game.week >= 3;
}

// Only call for a successful command response in the tab that issued the spin.
export function committedSpinBatch(roomId: string | null, before: GameState, after: GameState) {
  const spin = after.lastSpin;
  if (!liveAutoEnabled(roomId, after) || !spin || before.lastSpin?.id === spin.id) return null;
  const assignments = after.assignments.filter(a => a.season === after.season && a.week === after.week
    && !a.dropped && (a.id === spin.id || a.awardedWithSpinId === spin.id)
    && !before.assignments.some(old => old.id === a.id));
  return assignments.length ? { assignments, revealAt: spin.startedAt + spinDurationMs } : null;
}
