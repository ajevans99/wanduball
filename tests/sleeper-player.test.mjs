import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { liveRoomId, liveLeagueId, rosterStatus, parseRosters } from "../supabase/functions/sleeper-player/policy.ts";
import * as policy from "../supabase/functions/sleeper-player/policy.ts";
import * as cleanup from "../supabase/functions/sleeper-player/cleanup.ts";

const assignment = () => ({
  id: "assignment-one", season: 2026, week: 2, dropped: false, applied: false,
  player: { id: "6804", position: "QB" }, manager: { id: "4" },
});
const roster = (id, players = []) => ({ league_id: liveLeagueId, roster_id: id, players, reserve: null, taxi: null });
const compiled = ts.transpileModule(readFileSync(new URL("../supabase/functions/sleeper-player/index.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture() {
  const f = {
    a: assignment(), rosters: [roster(4), roster(5)], claims: [], mutations: [], queries: 0, auth: true, canEdit: true,
    me: "996938453788999680", league: liveLeagueId, timeout: false, landed: true, saveFailure: false,
    playerValid: true, claimFailure: false, fetchFailure: false, version: 8, week: 2, lastSpin: null,
    cleanups: [], dropClaims: [], cleanupRpc: null,
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: f.auth ? { id: "owner" } : null } }) },
    from(table) {
      return { select() { return this; }, eq() {
        const result = { data: table === "rooms" ? { state: { assignments: [f.a], leagueId: f.league, season: 2026, week: f.week, lastSpin: f.lastSpin }, version: f.version }
          : table === "sleeper_room_bindings" ? { league_id: liveLeagueId }
          : table === "sleeper_cleanups" ? f.cleanups : table === "sleeper_drop_claims" ? f.dropClaims : structuredClone(f.claims) };
        return { ...result, single: async () => result, then: resolve => Promise.resolve(result).then(resolve) };
      } };
    },
    async rpc(name, args) {
      if (name === "sleeper_cleanup_step" && f.cleanupRpc) return f.cleanupRpc(args);
      if (name === "observe_sleeper_players") return {};
      if (name === "room_commissioner_access") return { data: { canEdit: f.canEdit } };
      if (name === "claim_sleeper_player") {
        if (f.claimFailure || !f.canEdit || f.claims.length) return { error: {} };
        assert.equal(args.p_version, f.version);
        const claim = { id: "claim-one", assignment_id: f.a.id, player_id: f.a.player.id, status: "uncertain" };
        f.claims.push(claim);
        return { data: claim };
      }
      if (name === "verify_sleeper_player") {
        if (f.saveFailure) return { error: {} };
        f.claims.find(c => c.id === args.p_claim_id).status = "verified";
        f.a.applied = true;
        f.version++;
        return {};
      }
      throw new Error(name);
    },
  };
  const fetcher = async (url, init) => {
    if (url.includes("/players/nfl/")) return Response.json(f.playerValid ? { player_id: f.a.player.id, position: f.a.player.position } : {});
    assert.equal(init.headers.Authorization, "fixture-session", "Sleeper uses the raw session token, not Bearer");
    const { query } = JSON.parse(init.body);
    if (query.startsWith("mutation")) {
      f.mutations.push(query);
      const drop = query.includes("k_drops:");
      if (f.landed) {
        if (drop) f.rosters[0].players = f.rosters[0].players.filter(id => id !== f.a.player.id);
        else f.rosters[0].players.push(f.a.player.id);
      }
      if (f.timeout) throw new Error("timeout");
      return Response.json({ data: { league_create_transaction: drop
        ? { transaction_id: "12345", type: "commissioner", status: "complete", drops: { [f.a.player.id]: 4 }, adds: null }
        : { transaction_id: "txn" } } });
    }
    f.queries++;
    if (f.fetchFailure) throw new Error("unavailable");
    return Response.json({ data: { me: { user_id: f.me }, league_rosters: f.rosters } });
  };
  let handler;
  compileFunction(compiled, ["exports", "require", "Deno", "fetch"])({}, name => name.startsWith("npm:") ? { createClient: () => db } : name.includes("cleanup") ? cleanup : policy, {
    env: { get: key => ({
      SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
      SLEEPER_SESSION_TOKEN: "fixture-session", SLEEPER_USER_ID: "996938453788999680", SLEEPER_LEAGUE_ID: liveLeagueId,
    })[key] }, serve: fn => { handler = fn; },
  }, fetcher);
  f.call = async (action = "status", extras = {}) => {
    const res = await handler(new Request("https://fixture.invalid", {
      method: "POST", headers: { Authorization: "Bearer fixture-user" },
      body: JSON.stringify({ roomId: liveRoomId, action, ...(action === "apply" ? { assignmentId: f.a.id } : {}), ...extras }),
    }));
    return { status: res.status, body: await res.json() };
  };
  return f;
}
test("membership parser rejects missing, malformed, duplicate, or wrong-league rosters", () => {
  for (const value of [null, [], [roster(4), roster(4)], [{ ...roster(4), league_id: "wrong" }], [{ ...roster(4), players: {} }]])
    assert.throws(() => parseRosters(value));
  assert.deepEqual(parseRosters([roster(4)]), [roster(4)]);
});
test("Edge cleanup validates contract/auth, derives targets via private RPC, drops once and finishes through coordinator", async () => {
  const f = fixture();
  f.rosters[0].players = [f.a.player.id, "untouched"];
  const phases = [];
  f.cleanupRpc = async args => {
    assert.equal(args.p_week, 2);
    assert.equal(args.p_room_id, liveRoomId);
    phases.push(args.p_phase);
    if (args.p_phase === "preview") return { data: { targets: [f.a], week: 2, season: 2026, version: 8 } };
    if (args.p_phase === "acquire") return { data: { id: "op", worker: "worker", targets: [f.a] } };
    if (args.p_phase === "claim") f.dropClaims.push({ assignment_id: f.a.id, player_id: f.a.player.id, roster_id: 4, status: "uncertain", created_at: new Date().toISOString() });
    if (args.p_phase === "verify") {
      assert.equal(args.p_transaction_id, "12345");
      assert.equal(args.p_evidence, "transaction");
      f.dropClaims[0].status = "verified";
    }
    return { data: args.p_phase === "finish" ? { completed: true } : {} };
  };
  const params = { season: 2026, week: 2, version: 8 };
  assert.equal((await f.call("cleanup-preview", params)).body.count, 1);
  assert.equal(f.mutations.length, 0);
  assert.equal((await f.call("cleanup-step", { ...params, playerId: "bad" })).status, 400);
  f.canEdit = false;
  assert.equal((await f.call("cleanup-step", params)).status, 403);
  f.canEdit = true;
  assert.equal((await f.call("cleanup-step", params)).body.done, 1);
  assert.equal((await f.call("cleanup-step", params)).body.completed, true);
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.rosters[0].players, ["untouched"]);
  assert.ok(phases.includes("authorize"));
  f.cleanups = [{ status: "active" }];
  assert.equal((await f.call()).body.cleanupActive, true);
  assert.equal((await f.call("apply")).status, 409);
});
test("policy covers conflicts, reserve/taxi, missing roster, practice IDs and disabled/history/dropped assignments", () => {
  const a = assignment();
  assert.equal(rosterStatus(a, [roster(4, ["6804"])], false, true).status, "applied");
  assert.equal(rosterStatus(a, [{ ...roster(4), taxi: ["6804"] }], false, true).status, "applied");
  assert.equal(rosterStatus(a, [roster(4), roster(5, ["6804"])], false, true).status, "conflict");
  assert.equal(rosterStatus(a, [roster(5)], false, true).canApply, false);
  for (const patch of [{ dropped: true }, { week: 1 }, { player: { id: "demo-1", position: "QB" } }, { player: { id: "6804", position: "TE" } }])
    assert.equal(rosterStatus({ ...a, ...patch }, [roster(4)], false, true).canApply, false);
});
test("live rounds advance without redeployment; history and unrevealed pairs stay blocked", async () => {
  const future = fixture(); future.week = 3; future.a.week = 3;
  assert.equal((await future.call("apply")).status, 200);
  const history = fixture(); history.week = 3;
  assert.equal((await history.call("apply")).status, 409);
  assert.equal(history.mutations.length, 0);
  for (const paired of [false, true]) {
    const f = fixture(); f.week = 3; f.a.week = 3;
    f.lastSpin = { id: paired ? "ninth" : f.a.id, startedAt: Date.now() };
    if (paired) f.a.awardedWithSpinId = "ninth";
    assert.equal((await f.call("apply")).status, 409);
    assert.equal(f.mutations.length, 0);
    f.lastSpin.startedAt -= 6000;
    assert.equal((await f.call("apply")).status, 200);
  }
});
test("status sends no external writes and reports observed absence, never the stored applied flag", async () => {
  const f = fixture(); f.a.applied = true;
  const res = await f.call();
  assert.equal(res.body.assignments[f.a.id].status, "absent");
  assert.equal(f.mutations.length, 0);
  assert.equal(f.claims.length, 0);
});
test("single add uses stored identity, exactly one mutation, and independent verification", async () => {
  const f = fixture();
  assert.equal((await f.call("apply")).status, 200);
  assert.equal(f.mutations.length, 1);
  assert.match(f.mutations[0], /k_adds:\["6804"\],v_adds:\[4\]/);
  assert.doesNotMatch(f.mutations[0], /k_drops:|v_drops:|starters:/);
  assert.equal(f.queries, 3);
  assert.equal(f.claims[0].status, "verified");
  assert.equal(f.a.applied, true);
  assert.equal((await f.call("apply")).status, 200);
  assert.equal(f.mutations.length, 1);
});
test("already on target is a verified no-op", async () => {
  const f = fixture(); f.rosters[0].players = ["6804"];
  assert.equal((await f.call("apply")).status, 200);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.a.applied, true);
});
test("timeouts never blindly retry; successful external write is recovered by verification", async () => {
  const f = fixture(); f.timeout = true;
  assert.equal((await f.call("apply")).status, 200);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.claims[0].status, "verified");
});
test("ambiguous absent outcome stays claimed and permanently blocks another write", async () => {
  const f = fixture(); f.timeout = true; f.landed = false;
  assert.equal((await f.call("apply")).status, 409);
  assert.equal((await f.call("apply")).status, 409);
  assert.equal((await f.call()).body.assignments[f.a.id].status, "verification-required");
  assert.equal(f.mutations.length, 1);
});
test("DB save failure recovers on status with no second mutation", async () => {
  const f = fixture(); f.saveFailure = true;
  assert.equal((await f.call("apply")).status, 503);
  f.saveFailure = false;
  assert.equal((await f.call()).status, 200);
  assert.equal(f.claims[0].status, "verified");
  assert.equal(f.mutations.length, 1);
});
test("conflicting rosters and dropped or TE assignments cannot send adds", async () => {
  for (const configure of [f => f.rosters[1].players.push("6804"), f => { f.a.dropped = true; }, f => { f.a.player.position = "TE"; }]) {
    const f = fixture(); configure(f);
    assert.equal((await f.call("apply")).status, 409);
    assert.equal(f.mutations.length, 0);
  }
});
test("unauthorized, revoked, mismatched account, wrong league and fake identity fail closed", async () => {
  for (const configure of [f => { f.auth = false; }, f => { f.canEdit = false; }, f => { f.me = "other"; },
    f => { f.league = "other"; }, f => { f.playerValid = false; }, f => { f.claimFailure = true; }]) {
    const f = fixture(); configure(f);
    assert.ok((await f.call("apply")).status >= 400);
    assert.equal(f.mutations.length, 0);
  }
});
test("unbound rooms and browser-supplied player/roster IDs are rejected", async () => {
  for (const extra of [{ roomId: "other" }, { playerId: "123" }, { rosterId: 1 }, { assignmentId: "missing" }]) {
    const f = fixture();
    assert.ok((await f.call("apply", extra)).status >= 400);
    assert.equal(f.mutations.length, 0);
  }
});
test("status upstream failure explicitly unavailable rather than fabricated absence", async () => {
  const f = fixture(); f.fetchFailure = true;
  const res = await f.call();
  assert.equal(res.status, 503);
  assert.equal(res.body.assignments, undefined);
});
test("concurrent applies can issue at most one mutation", async () => {
  const f = fixture();
  await Promise.all([f.call("apply"), f.call("apply")]);
  assert.equal(f.mutations.length, 1);
});
