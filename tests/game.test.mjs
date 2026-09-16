import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState } from "../src/lib/seed.ts";
import { assignmentLeadInMs, commandSchema, currentAssignments, nicknameMaxLength, playerLabel, pool, spinDurationMs, stateSchema, transition } from "../src/lib/game.ts";
import { wheelColors } from "../src/lib/wheel.ts";

function coordinator() {
  let state = initialState();
  let now = 1_000_000;
  return {
    get state() { return state; },
    run(command, index = 0) {
      now += 10_000;
      state = transition(state, command, max => index % max, now);
      return state;
    },
  };
}

test("exclusions refill the top ten and locking freezes a pool", () => {
  const game = coordinator();
  const first = pool(game.state, "QB")[0];
  game.run({ type: "exclude", playerId: first.id });
  assert.equal(pool(game.state, "QB").length, 10);
  assert.equal(pool(game.state, "QB").some(p => p.id === first.id), false);
  assert.equal(pool(game.state, "QB")[9].name, "Jalen Hurts");
  game.run({ type: "lock", position: "QB" });
  assert.throws(() => game.run({ type: "exclude", playerId: first.id }), /already locked/);
});

test("imports exclude Out and IR, refill pools, and allow manual overrides", () => {
  const state = initialState();
  const players = structuredClone(state.players);
  const top = pool(state, "QB");
  players.push({ ...top[0], id: "extra-reserve", points: 1, injury: null });
  const statuses = ["Out", " ir ", "Injured Reserve", "Questionable", "Doubtful", null];
  top.slice(0, statuses.length).forEach((player, index) => {
    players.find(candidate => candidate.id === player.id).injury = statuses[index];
  });
  let imported = transition(state, {
    type: "import", players, season: state.season, week: state.week,
    leagueId: "1389331555339468800", managers: state.managers, source: "Sleeper",
  }, () => 0);
  for (const player of top.slice(0, 3)) {
    assert.ok(imported.excluded.includes(player.id));
    assert.ok(!pool(imported, "QB").some(candidate => candidate.id === player.id));
  }
  for (const player of top.slice(3, 6)) assert.ok(!imported.excluded.includes(player.id));
  assert.equal(pool(imported, "QB").length, 10);
  imported = transition(imported, { type: "exclude", playerId: top[0].id }, () => 0);
  assert.ok(pool(imported, "QB").some(player => player.id === top[0].id));
});

test("nine spins make ten unique player-manager pairs per position", () => {
  const game = coordinator();
  assert.throws(() => game.run({ type: "assign", position: "QB" }), /lock/);
  game.run({ type: "lock", position: "QB" });
  for (let i = 0; i < 9; i++) game.run({ type: "assign", position: "QB" }, i);
  const results = currentAssignments(game.state, "QB");
  assert.equal(results.length, 10);
  assert.equal(new Set(results.map(a => a.manager.id)).size, 10);
  assert.equal(new Set(results.map(a => a.player.id)).size, 10);
  assert.throws(() => game.run({ type: "assign", position: "QB" }), /have a home/);
  game.run({ type: "lock", position: "RB" });
  game.run({ type: "assign", position: "RB" });
  assert.equal(currentAssignments(game.state).length, 11);
});

test("scoring round enforces assignment completion, order, and replacement points", () => {
  const game = coordinator();
  assert.throws(() => game.run({ type: "coin" }), /Finish/);
  assert.throws(() => game.run({ type: "rule" }), /coin first/);
  assert.throws(() => game.run({ type: "points" }), /rule wheel/);
  game.run({ type: "lock", position: "WR" });
  for (let i = 0; i < 9; i++) game.run({ type: "assign", position: "WR" });
  game.run({ type: "coin" });
  assert.equal(game.state.pending.duration, "Weekly");
  assert.throws(() => game.run({ type: "lock", position: "RB" }), /scoring round has started/);
  assert.throws(() => game.run({ type: "assign", position: "WR" }), /scoring round has started/);
  game.run({ type: "rule" }, 12);
  assert.equal(game.state.pending.ruleId, "idp_pass_def");
  game.run({ type: "points" }, 14);
  assert.equal(game.state.changes[0].previous, -5);
  assert.equal(game.state.changes[0].value, -90);
  assert.throws(() => game.run({ type: "coin" }), /already started/);
});

test("last assignment is paired with the ninth spin and preserves nicknames", () => {
  const game = coordinator();
  game.run({ type: "lock", position: "QB" });
  const lastPlayer = pool(game.state, "QB")[9];
  game.run({ type: "nickname", playerId: lastPlayer.id, nickname: "Mr Irrelevant" });
  for (let i = 0; i < 9; i++) game.run({ type: "assign", position: "QB" });
  const last = game.state.assignments[9];
  assert.equal(last.nickname, "Mr Irrelevant");
  assert.equal(last.awardedWithSpinId, game.state.lastSpin.id);
  assert.notEqual(last.id, game.state.lastSpin.id);
  assert.equal(game.state.lastSpin.options.length, 2);
  const legacy = structuredClone(game.state);
  legacy.assignments.pop();
  const now = legacy.lastSpin.startedAt + spinDurationMs;
  const completed = transition(legacy, { type: "assign", position: "QB" }, () => {
    throw new Error("The final assignment must not use RNG");
  }, now);
  assert.equal(completed.assignments.length, 10);
  assert.equal(completed.lastSpin.startedAt + spinDurationMs, now);
});

test("points layout is shuffled once and the selected slice matches the saved value", () => {
  const state = initialState();
  state.pending.duration = "Weekly";
  state.pending.ruleId = state.rules.find(rule => rule.duration === "Weekly").id;
  const first = transition(state, { type: "points" }, () => 0);
  const second = transition(state, { type: "points" }, max => max - 1);
  assert.notDeepEqual(first.lastSpin.options, second.lastSpin.options);
  assert.deepEqual([...first.lastSpin.options].sort(), [...second.lastSpin.options].sort());
  assert.equal(new Set(first.lastSpin.options).size, 15);
  for (const result of [first, second]) {
    assert.equal(parseInt(result.lastSpin.options[result.lastSpin.index]), result.changes[0].value);
    assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(result))).lastSpin, result.lastSpin);
  }
});

test("weekly cleanup must be completed before advancing and preserves history", () => {
  const game = coordinator();
  game.run({ type: "lock", position: "RB" });
  for (let i = 0; i < 9; i++) game.run({ type: "assign", position: "RB" });
  game.run({ type: "coin" });
  game.run({ type: "rule" });
  game.run({ type: "points" });
  assert.throws(() => game.run({ type: "next-week" }), /Confirm/);
  const first = game.state.assignments[0];
  assert.throws(() => game.run({ type: "assignment-status", id: first.id, field: "dropped" }), /applied/);
  for (const assignment of game.state.assignments) {
    game.run({ type: "assignment-status", id: assignment.id, field: "applied" });
    game.run({ type: "assignment-status", id: assignment.id, field: "dropped" });
  }
  const change = game.state.changes[0];
  game.run({ type: "change-status", id: change.id, field: "applied" });
  assert.throws(() => game.run({ type: "next-week" }), /Confirm/);
  game.run({ type: "change-status", id: change.id, field: "reverted" });
  game.run({ type: "next-week" });
  assert.equal(game.state.week, 2);
  assert.equal(game.state.players.length, 0);
  assert.equal(game.state.assignments.length, 10);
  assert.equal(currentAssignments(game.state).length, 0);
  assert.equal(game.state.changes[0].reverted, true);
});

test("permanent changes carry forward and cannot be marked reverted", () => {
  const game = coordinator();
  game.run({ type: "lock", position: "QB" });
  for (let i = 0; i < 9; i++) game.run({ type: "assign", position: "QB" });
  game.run({ type: "coin" }, 1);
  game.run({ type: "rule" });
  game.run({ type: "points" }, 2);
  const change = game.state.changes[0];
  assert.equal(change.rule.duration, "Permanent");
  game.run({ type: "change-status", id: change.id, field: "applied" });
  assert.throws(() => game.run({ type: "change-status", id: change.id, field: "reverted" }), /weekly rule/);
});

test("active spins block duplicate commands and state is not mutated", () => {
  const initial = initialState();
  const locked = transition(initial, { type: "lock", position: "QB" }, () => 0, 1000);
  assert.equal(initial.locked.length, 0);
  const spinning = transition(locked, { type: "assign", position: "QB" }, () => 0, 2000);
  assert.throws(() => transition(spinning, { type: "assign", position: "QB" }, () => 0, 3000), /finish/);
  assert.equal(spinning.assignments.length, 1);
  const next = transition(spinning, { type: "assign", position: "QB" }, () => 0, spinning.lastSpin.startedAt + 5000);
  assert.equal(next.assignments.length, 2);
});

test("assignment announcement reserves one manager and result for the countdown and spin", () => {
  const now = 10_000;
  const locked = transition(initialState(), { type: "lock", position: "QB" }, () => 0, now);
  const picks = [4, 2];
  const announced = transition(locked, { type: "assign", position: "QB" }, () => picks.shift(), now);
  const assignment = announced.assignments[0];
  assert.equal(assignment.manager.id, locked.managers[4].id);
  assert.equal(assignment.player.id, pool(locked, "QB")[2].id);
  assert.equal(assignment.id, announced.lastSpin.id);
  assert.equal(announced.lastSpin.startedAt, now + assignmentLeadInMs);
  assert.equal(assignmentLeadInMs, 3000);
  const restored = stateSchema.parse(JSON.parse(JSON.stringify(announced)));
  assert.deepEqual(restored, announced);
  const finishesAt = now + assignmentLeadInMs + spinDurationMs;
  for (const time of [now, now + 2999, now + 3000, finishesAt - 1]) {
    assert.throws(() => transition(restored, { type: "assign", position: "QB" }, () => 0, time), /finish/);
  }
  assert.equal(transition(restored, { type: "assign", position: "QB" }, () => 0, finishesAt).assignments.length, 2);
});

test("wheel slices never share a color with their neighbors, including across the seam", () => {
  assert.deepEqual(wheelColors(0), []);
  assert.equal(wheelColors(1).length, 1);
  for (let count = 2; count <= 200; count++) {
    const colors = wheelColors(count);
    assert.equal(colors.length, count);
    for (let index = 0; index < count; index++) {
      assert.notEqual(colors[index], colors[(index + 1) % count], `${count} slices: adjacency at ${index}`);
    }
  }
});

test("imports sync baseline points and cannot overwrite a locked week", () => {
  const game = coordinator();
  const command = {
    type: "import", players: initialState().players, managers: initialState().managers,
    season: 2026, week: 1, leagueId: "123456789", source: "Sleeper",
    baselines: { idp_pass_def: 3, rec: 0.5 },
  };
  game.run(command);
  assert.equal(game.state.rules.find(r => r.id === "idp_pass_def").baseline, 3);
  assert.equal(game.state.rules.find(r => r.id === "blk_kick").baseline, 0);
  game.run({ type: "lock", position: "QB" });
  assert.throws(() => game.run(command), /in progress/);
});

test("invalid point values and empty rule names are rejected", () => {
  assert.equal(commandSchema.safeParse({ type: "add-rule", rule: { id: "x", name: "", duration: "Weekly", baseline: 0 } }).success, false);
  assert.equal(commandSchema.safeParse({ type: "add-rule", rule: { id: "x", name: "Test", duration: "Weekly", baseline: Infinity } }).success, false);
});

test("nicknames trim, update, and clear without changing imported players or pool eligibility", () => {
  const game = coordinator();
  const players = structuredClone(game.state.players);
  const originalPool = pool(game.state, "QB");
  const player = originalPool[0];
  game.run({ type: "nickname", playerId: player.id, nickname: "  The Buffalo  " });
  assert.equal(game.state.nicknames[player.id], "The Buffalo");
  assert.deepEqual(game.state.players, players);
  assert.deepEqual(pool(game.state, "QB"), originalPool);
  assert.equal(playerLabel(player, game.state.nicknames[player.id]), "The Buffalo (Josh Allen)");
  game.run({ type: "lock", position: "QB" });
  game.run({ type: "nickname", playerId: player.id, nickname: "Captain Chaos" });
  assert.equal(game.state.nicknames[player.id], "Captain Chaos");
  assert.deepEqual(game.state.locked, ["QB"]);
  assert.deepEqual(pool(game.state, "QB"), originalPool);
  game.run({ type: "nickname", playerId: player.id, nickname: "   " });
  assert.equal(Object.hasOwn(game.state.nicknames, player.id), false);
  assert.equal(playerLabel(player, game.state.nicknames[player.id]), player.name);
  game.run({ type: "nickname", playerId: player.id, nickname: "Another name" });
  game.run({ type: "nickname", playerId: player.id, nickname: "" });
  assert.deepEqual(game.state.nicknames, {});
});

test("nickname commands reject unknown players, invalid values, and excessive length", () => {
  const game = coordinator();
  const playerId = game.state.players[0].id;
  const command = { type: "nickname", playerId, nickname: "A".repeat(nicknameMaxLength) };
  assert.equal(commandSchema.safeParse(command).success, true);
  assert.equal(commandSchema.parse({ ...command, nickname: "  Ace  " }).nickname, "Ace");
  for (const nickname of ["A".repeat(nicknameMaxLength + 1), null, 42]) {
    assert.equal(commandSchema.safeParse({ ...command, nickname }).success, false);
    assert.throws(() => game.run({ ...command, nickname }));
  }
  assert.equal(commandSchema.safeParse({ ...command, playerId: "" }).success, false);
  assert.throws(() => game.run({ ...command, playerId: "missing" }), /Player not found/);
  assert.equal(game.state.nicknames, undefined);
});

test("nicknames belong to stable player IDs across repeat imports, absent players, and next week", () => {
  const game = coordinator();
  const sourcePlayers = initialState().players.map((player, index) => ({ ...player, id: String(4000 + index) }));
  const imported = {
    type: "import", players: sourcePlayers, managers: game.state.managers,
    season: 2026, week: 1, leagueId: "123456789", source: "Sleeper fixture",
  };
  game.run(imported);
  const player = sourcePlayers[0];
  game.run({ type: "nickname", playerId: player.id, nickname: "My QB" });
  game.run({ ...imported, players: sourcePlayers.slice(1) });
  assert.equal(game.state.nicknames[player.id], "My QB");
  const updatedPlayers = sourcePlayers.map(p => p.id === player.id ? { ...p, name: "Updated real name", team: "NEW", points: 400 } : p);
  game.run({ ...imported, players: updatedPlayers });
  assert.equal(game.state.nicknames[player.id], "My QB");
  assert.equal(game.state.players[0].name, "Updated real name");
  game.run({ type: "next-week" });
  assert.equal(game.state.players.length, 0);
  assert.equal(game.state.nicknames[player.id], "My QB");
  game.run({ ...imported, players: updatedPlayers, week: 2 });
  assert.equal(game.state.nicknames[player.id], "My QB");
  game.run({ type: "nickname", playerId: player.id, nickname: "" });
  game.run({ ...imported, week: 2 });
  assert.equal(game.state.nicknames[player.id], undefined);
});

test("all positions, reserves, and excluded players can have independent nicknames", () => {
  const game = coordinator();
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const players = game.state.players.filter(p => p.position === position);
    game.run({ type: "exclude", playerId: players[0].id });
    for (const player of [players[0], players.at(-1)]) {
      game.run({ type: "nickname", playerId: player.id, nickname: "Same nickname" });
      assert.equal(game.state.nicknames[player.id], "Same nickname");
    }
    assert.notEqual(playerLabel(players[0], "Same nickname"), playerLabel(players.at(-1), "Same nickname"));
  }
  assert.equal(Object.keys(game.state.nicknames).length, 8);
});

test("nickname edits cannot change the countdown or spin, and historical snapshots stay unchanged", () => {
  const now = 10_000;
  const initial = initialState();
  const player = pool(initial, "QB")[0];
  const command = { type: "nickname", playerId: player.id, nickname: "Original nickname" };
  const named = transition(initial, command, () => 0, now);
  assert.equal(initial.nicknames, undefined);
  const locked = transition(named, { type: "lock", position: "QB" }, () => 0, now);
  const announced = transition(locked, { type: "assign", position: "QB" }, () => 0, now);
  const label = `Original nickname (${player.name})`;
  assert.equal(announced.lastSpin.label, label);
  assert.equal(announced.lastSpin.options[0], label);
  assert.equal(announced.assignments[0].nickname, "Original nickname");
  assert.equal(announced.assignments[0].player.name, player.name);
  const restored = stateSchema.parse(JSON.parse(JSON.stringify(announced)));
  assert.deepEqual(restored, announced);
  const finishesAt = now + assignmentLeadInMs + spinDurationMs;
  for (const time of [now, now + 2999, now + 3000, finishesAt - 1]) {
    assert.throws(() => transition(restored, { ...command, nickname: "Too soon" }, () => 0, time), /finish/);
  }
  const renamed = transition(restored, { ...command, nickname: "New nickname" }, () => 0, finishesAt);
  const cleared = transition(renamed, { ...command, nickname: "" }, () => 0, finishesAt);
  for (const state of [renamed, cleared]) {
    assert.deepEqual(state.assignments, announced.assignments);
    assert.deepEqual(state.lastSpin, announced.lastSpin);
  }
});

test("pre-nickname saved games and assignments still parse and retain historical real names", () => {
  const now = 10_000;
  const locked = transition(initialState(), { type: "lock", position: "QB" }, () => 0, now);
  const old = transition(locked, { type: "assign", position: "QB" }, () => 0, now);
  const restored = stateSchema.parse(JSON.parse(JSON.stringify(old)));
  assert.equal(restored.nicknames, undefined);
  assert.equal(restored.assignments[0].nickname, undefined);
  const player = restored.assignments[0].player;
  const renamed = transition(restored, { type: "nickname", playerId: player.id, nickname: "New era" }, () => 0, now + 9000);
  assert.equal(renamed.lastSpin.label, player.name);
  assert.equal(renamed.assignments[0].nickname, undefined);
  assert.equal(playerLabel(player, renamed.assignments[0].nickname), player.name);
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(renamed))), renamed);
});
