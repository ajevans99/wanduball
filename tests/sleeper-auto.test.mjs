import assert from "node:assert/strict";
import { test } from "node:test";
import { committedSpinBatch, liveAutoEnabled, sleeperLiveRoomId } from "../src/lib/sleeper-auto.ts";
import { initialState } from "../src/lib/seed.ts";
import { spinDurationMs } from "../src/lib/game.ts";

test("auto batches only newly committed current-round reveals, including the final default player", () => {
  const before = { ...initialState(), season: 2026, week: 3, leagueId: "1389331555339468800" };
  const a = { id: "ninth", season: 2026, week: 3, dropped: false };
  const after = { ...before, lastSpin: { id: "ninth", startedAt: 12345 },
    assignments: [{ ...a, id: "backlog" }, a, { ...a, id: "tenth", awardedWithSpinId: "ninth" }] };
  const batch = committedSpinBatch(sleeperLiveRoomId, before, after);
  assert.deepEqual(batch.assignments.map(a => a.id), ["ninth", "tenth"]);
  assert.equal(batch.revealAt, 12345 + spinDurationMs);
  assert.equal(committedSpinBatch(sleeperLiveRoomId, after, after), null);
  assert.equal(committedSpinBatch(sleeperLiveRoomId, before, { ...after, lastSpin: { id: "scoring" } }), null);
  for (const patch of [{ week: 2 }, { season: 2027 }, { leagueId: "other" }])
    assert.equal(liveAutoEnabled(sleeperLiveRoomId, { ...after, ...patch }), false);
  assert.equal(liveAutoEnabled(null, after), false);
  assert.equal(liveAutoEnabled("other", after), false);
});
