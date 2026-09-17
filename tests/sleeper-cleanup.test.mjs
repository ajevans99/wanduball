import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupStep, exactDrop, dropMutation } from "../supabase/functions/sleeper-player/cleanup.ts";
import { liveLeagueId } from "../supabase/functions/sleeper-player/policy.ts";

function fixture() {
  const a = id => ({ id, season: 2026, week: 2, dropped: false, player: { id, position: "QB" }, manager: { id: "4" } });
  const f = {
    targets: [a("100"), a("200")], claims: [], writes: [], transactions: [],
    rosters: [{ league_id: liveLeagueId, roster_id: 4, players: ["100", "200", "300", "400"], reserve: [], taxi: [] },
      { league_id: liveLeagueId, roster_id: 5, players: ["500"], reserve: [], taxi: [] }],
    complete: false, worker: null, permission: true, landed: true, timeout: false, failure: false,
  };
  f.services = {
    async phase(phase, worker, id, transaction, evidence) {
      if (!f.permission) throw new Error("Commissioner access required");
      if (phase === "acquire") {
        if (f.worker) throw new Error("Another commissioner");
        f.worker = "worker";
        return { id: "op", worker: f.worker, targets: f.targets };
      }
      assert.equal(worker, f.worker);
      if (phase === "release") { f.worker = null; return; }
      if (phase === "claim") {
        assert.ok(!f.claims.some(c => c.assignment_id === id));
        const c = { assignment_id: id, player_id: id, roster_id: 4, created_at: new Date(Date.now() - 10).toISOString(), status: "uncertain" };
        f.claims.push(c);
        return c;
      }
      if (phase === "authorize") { if (f.failure) throw new Error("Stale permission"); return; }
      if (phase === "verify") {
        Object.assign(f.claims.find(c => c.assignment_id === id), { status: "verified", transaction_id: transaction, evidence });
      }
      if (phase === "finish") { f.complete = true; return { completed: true }; }
    },
    async claims() { return structuredClone(f.claims); },
    async rosters() { return structuredClone(f.rosters); },
    async drop(a) {
      f.writes.push(dropMutation(a));
      const t = { transaction_id: String(1000 + f.writes.length), type: "commissioner", status: "complete", drops: { [a.player.id]: 4 }, adds: null, created: Date.now() };
      if (f.landed) { f.rosters[0].players = f.rosters[0].players.filter(id => id !== a.player.id); f.transactions.push(t); }
      if (f.timeout) throw new Error("Timeout");
      return t;
    },
    async transactions() { return f.transactions; },
  };
  return f;
}
test("full cleanup drops only server targets, preserves TE/history/unrelated and advances only after verification", async () => {
  const f = fixture();
  assert.deepEqual(await cleanupStep(f.services), { completed: false, done: 1, total: 2 });
  assert.equal(f.complete, false);
  await cleanupStep(f.services);
  assert.equal(f.complete, false);
  assert.deepEqual(await cleanupStep(f.services), { completed: true });
  assert.deepEqual(f.rosters.map(r => r.players), [["300", "400"], ["500"]]);
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(q => q.includes("k_drops:") && !q.includes("k_adds:")));
});
test("whole-set preflight catches a later moved player before any drop", async () => {
  const f = fixture();
  f.rosters[0].players = ["100"];
  f.rosters[1].taxi = ["200"];
  await assert.rejects(cleanupStep(f.services), /commissioner review/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.complete, false);
});
test("already absent is durably verified without mutation", async () => {
  const f = fixture();
  f.rosters[0].players = [];
  await cleanupStep(f.services);
  await cleanupStep(f.services);
  await cleanupStep(f.services);
  assert.equal(f.writes.length, 0);
  assert.ok(f.claims.every(c => c.evidence === "already-absent"));
});
test("timeout reconciles exact transaction and absence, never blindly retries", async () => {
  const f = fixture();
  f.timeout = true;
  await cleanupStep(f.services);
  assert.equal(f.claims[0].status, "verified");
  const g = fixture();
  g.timeout = true; g.landed = false;
  await assert.rejects(cleanupStep(g.services), /unverified/);
  await assert.rejects(cleanupStep(g.services), /uncertain/);
  assert.equal(g.writes.length, 1);
  assert.equal(g.complete, false);
});
test("partial failure preserves completed audit, resumed uncertain work is reconciliation only", async () => {
  const f = fixture();
  await cleanupStep(f.services);
  f.timeout = true; f.landed = false;
  await assert.rejects(cleanupStep(f.services), /unverified/);
  assert.equal(f.claims[0].status, "verified");
  await assert.rejects(cleanupStep(f.services), /uncertain/);
  assert.equal(f.writes.length, 2);
  assert.equal(f.complete, false);
});
test("per-target recheck, latest authorization, concurrency and returned-player final gate", async () => {
  const f = fixture();
  let reads = 0;
  f.services.rosters = async () => {
    if (++reads === 3) f.rosters[1].players.push("100");
    return structuredClone(f.rosters);
  };
  await assert.rejects(cleanupStep(f.services), /commissioner review/);
  assert.equal(f.writes.length, 0);
  const g = fixture(); g.failure = true;
  await assert.rejects(cleanupStep(g.services), /Stale permission/);
  assert.equal(g.writes.length, 0);
  const h = fixture(); h.worker = "other";
  await assert.rejects(cleanupStep(h.services), /Another commissioner/);
  const j = fixture();
  await cleanupStep(j.services); await cleanupStep(j.services);
  j.rosters[0].players.push("100");
  await assert.rejects(cleanupStep(j.services), /back on a roster/);
  assert.equal(j.complete, false);
});
test("wrong roster/extra players/adds/old transactions cannot prove an uncertain drop", async () => {
  const f = fixture();
  const t = { transaction_id: "123", type: "commissioner", status: "complete", drops: { "100": 4 }, adds: null };
  assert.equal(exactDrop(t, f.targets[0]), true);
  for (const bad of [{ ...t, drops: { "100": 5 } }, { ...t, drops: { "100": 4, "200": 4 } },
    { ...t, adds: { "200": 4 } }, { ...t, status: "pending" }]) assert.equal(exactDrop(bad, f.targets[0]), false);
  assert.throws(() => dropMutation({ ...f.targets[0], player: { id: "100", position: "TE" } }));
  f.claims.push({ assignment_id: "100", status: "uncertain", created_at: new Date().toISOString() });
  f.rosters[0].players = [];
  f.transactions.push({ ...t, created: 1 });
  await assert.rejects(cleanupStep(f.services), /uncertain/);
  assert.equal(f.writes.length, 0);
});
