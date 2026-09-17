import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareCorrection, roomId, leagueId } from "../scripts/room-week-correction.mjs";
import { initialState } from "../src/lib/seed.ts";
import { currentAssignments, stateSchema, transition } from "../src/lib/game.ts";

function fixture() {
  const state = initialState();
  state.week = 1;
  state.season = 2026;
  state.leagueId = leagueId;
  state.managers = state.managers.map((m, i) => ({ ...m, id: String(i + 1) }));
  state.lastSpin = null;
  const players = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    [String(i + 100), { full_name: `Player ${i}`, position: i < 10 ? "QB" : i < 20 ? "RB" : i < 30 ? "WR" : "TE" }]));
  state.assignments = Object.entries(players).map(([id, p]) => ({
    id: `assignment-${id}`, week: 1, season: 2026,
    player: { id, name: p.full_name, position: p.position, points: 123, injury: null, team: "NFL" },
    manager: state.managers[0], applied: true, dropped: false, nickname: "Keep me", awardedWithSpinId: "old-spin",
  }));
  state.changes = [{ id: "change", season: 2026, week: 1, rule: state.rules[0], value: -5, previous: 0, applied: true, reverted: true }];
  const transactions = Object.keys(players).slice(0, 30).map((id, i) => ({
    transaction_id: `add-${i}`, type: "commissioner", status: "complete", created: 1000 + i,
    adds: { [id]: Number(state.managers[0].id) }, drops: null,
  }));
  const laterTransactions = transactions.map((t, i) => ({
    transaction_id: `drop-${i}`, type: "commissioner", status: "complete", created: 2000 + i,
    adds: null, drops: t.adds,
  }));
  return { rooms: [{ id: roomId, state, version: 53 }], players, users: [],
    rosters: [{ roster_id: Number(state.managers[0].id) }],
    sleeper_apply_claims: [], sleeper_room_bindings: [{ room_id: roomId, league_id: leagueId, season: 2026, week: 1 }],
    transactions, laterTransactions };
}

test("correction preserves every current field except round labels and imports only roster evidence", () => {
  const f = fixture(), before = structuredClone(f);
  const next = prepareCorrection(f);
  assert.deepEqual(f, before);
  assert.equal(next.week, 2);
  assert.equal(currentAssignments(next).length, 40);
  assert.equal(next.rosterHistory.length, 30);
  for (const a of next.rosterHistory) {
    assert.equal(a.source, "sleeper-commissioner-add");
    assert.ok(a.removalTransactionId);
    assert.equal(a.player.points, undefined);
    assert.equal(a.awardedWithSpinId, undefined);
    assert.equal(a.applied, undefined);
    assert.equal(a.nickname, undefined);
  }
  const restored = structuredClone(next);
  delete restored.rosterHistory;
  restored.week = 1;
  restored.assignments.forEach(a => { a.week = 1; });
  restored.changes.forEach(c => { c.week = 1; });
  assert.deepEqual(restored, f.rooms[0].state);
  assert.deepEqual(stateSchema.parse(next), next);
  assert.deepEqual(transition(next, { type: "nickname", playerId: next.players[0].id, nickname: "Hello" }, () => 0).rosterHistory, next.rosterHistory);
});

test("exact source duplicates are deduplicated and incomplete/noncommissioner adds ignored", () => {
  const f = fixture();
  f.transactions.push(structuredClone(f.transactions[0]));
  f.transactions.push({ ...f.transactions[0], transaction_id: "pending", status: "pending" });
  f.transactions.push({ ...f.transactions[0], transaction_id: "waiver", type: "waiver" });
  assert.equal(prepareCorrection(f).rosterHistory.length, 30);
  f.transactions.push({ ...f.transactions[0], created: 999 });
  assert.throws(() => prepareCorrection(f), /Conflicting transaction duplicate/);
});

test("reruns, wrong rooms, uncertain claims and unexplained repeated adds stop", () => {
  const f = fixture();
  f.rooms[0].state = prepareCorrection(f);
  assert.throws(() => prepareCorrection(f), /Already corrected/);
  const wrong = fixture(); wrong.rooms[0].id = "other-room";
  assert.throws(() => prepareCorrection(wrong));
  const claim = fixture(); claim.sleeper_apply_claims.push({ status: "uncertain" });
  assert.throws(() => prepareCorrection(claim), /Uncertain/);
  const repeated = fixture(); repeated.transactions.push({ ...repeated.transactions[0], transaction_id: "second-add" });
  assert.throws(() => prepareCorrection(repeated), /count/);
});
