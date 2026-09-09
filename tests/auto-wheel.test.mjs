import assert from "node:assert/strict";
import { test } from "node:test";
import { nextWheel } from "../src/lib/auto-wheel.ts";
import { transition } from "../src/lib/game.ts";
import { initialState } from "../src/lib/seed.ts";

test("auto sequence visits only locked pools and never starts round two", () => {
    let state = initialState();
    let now = 1_000_000;
    assert.equal(nextWheel(state), null);
    for (const position of ["TE", "QB"])
        state = transition(state, { type: "lock", position }, () => 0, now += 10_000);
    const commands = [];
    while (nextWheel(state)) {
        const { command } = nextWheel(state);
        commands.push(command.type === "assign" ? command.position : command.type);
        assert.ok(commands.length <= 20);
        state = transition(state, command, () => 0, now += 10_000);
    }
    assert.deepEqual(commands, [...Array(10).fill("QB"), ...Array(10).fill("TE")]);
    assert.equal(state.changes.length, 0);
    assert.equal(state.assignments.length, 20);
    assert.ok(state.assignments.every(a => !a.applied && !a.dropped));
    assert.deepEqual(state.pending, { duration: null, ruleId: null });
    assert.equal(state.week, 1);
});

test("auto never continues a partially completed scoring round", () => {
    const state = initialState();
    state.pending.duration = "Permanent";
    assert.equal(nextWheel(state), null);
    state.pending.ruleId = state.rules.find(rule => rule.duration === "Permanent").id;
    assert.equal(nextWheel(state), null);
    state.rules = [];
    assert.equal(nextWheel(state), null);
});

test("auto has no assignment when a locked pool has no eligible player or manager", () => {
    const state = initialState();
    state.locked = ["QB"];
    state.players = [];
    assert.equal(nextWheel(state), null);
    state.players = initialState().players;
    state.managers = [];
    assert.equal(nextWheel(state), null);
});
