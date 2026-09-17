import assert from "node:assert/strict";

export const roomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
export const leagueId = "1389331555339468800";

// Pure preparation: this module never calls Sleeper or writes to a database.
export function prepareCorrection(snapshot) {
  const room = snapshot.rooms[0];
  assert.equal(snapshot.rooms.length, 1);
  assert.equal(room.id, roomId);
  const state = structuredClone(room.state);
  assert.equal(state.leagueId, leagueId);
  assert.equal(state.season, 2026);
  assert.equal(state.week, 1, "Already corrected or conflicting round; stop, never reimport");
  assert.equal(state.assignments.length, 40);
  assert.ok(!state.rosterHistory?.length, "History already exists; stop");
  assert.ok(snapshot.sleeper_apply_claims.every(c => c.status === "verified"), "Uncertain add; stop");
  const binding = snapshot.sleeper_room_bindings[0];
  assert.equal(binding?.room_id, roomId);
  assert.equal(binding.league_id, leagueId);
  assert.equal(binding.season, 2026);
  assert.equal(binding.week, 1);
  const unique = new Map();
  for (const t of [...snapshot.transactions, ...snapshot.laterTransactions]) {
    if (unique.has(t.transaction_id))
      assert.deepEqual(unique.get(t.transaction_id), t, "Conflicting transaction duplicate");
    unique.set(t.transaction_id, t);
  }
  const events = [...unique.values()].filter(t => t.status === "complete")
    .sort((a, b) => a.created - b.created || a.transaction_id.localeCompare(b.transaction_id));
  const weekOneIds = new Set(snapshot.transactions.map(t => t.transaction_id));
  const history = [];
  for (const [index, t] of events.entries()) {
    if (!weekOneIds.has(t.transaction_id) || t.type !== "commissioner") continue;
    for (const [playerId, rosterId] of Object.entries(t.adds ?? {})) {
      const known = state.assignments.find(a => a.player.id === playerId)?.player
        ?? state.players.find(p => p.id === playerId);
      const player = snapshot.players[playerId];
      assert.ok(player, `Missing player ${playerId}`);
      const roster = snapshot.rosters.find(r => r.roster_id === rosterId);
      assert.ok(roster, `Missing roster ${rosterId}`);
      const user = snapshot.users.find(u => u.user_id === roster.owner_id);
      const manager = state.managers.find(m => m.id === String(rosterId))
        ?? { id: String(rosterId), name: user?.metadata?.team_name || user?.display_name };
      assert.ok(manager.name, `Missing manager ${rosterId}`);
      const removal = events.slice(index + 1).find(e =>
        e.drops?.[playerId] === rosterId ||
        (e.adds?.[playerId] !== undefined && e.adds[playerId] !== rosterId));
      history.push({
        id: `sleeper:${leagueId}:${t.transaction_id}:${playerId}:${rosterId}`,
        season: 2026, week: 1, source: "sleeper-commissioner-add",
        transactionId: t.transaction_id, occurredAt: t.created,
        player: { id: playerId, name: known?.name ?? player.full_name ?? `${player.first_name} ${player.last_name}`,
          position: known?.position ?? player.position },
        manager,
        ...(removal ? { removalTransactionId: removal.transaction_id, removedAt: removal.created } : {}),
      });
    }
  }
  assert.equal(history.length, 30, "Unexpected Week 1 commissioner-add count");
  assert.equal(new Set(history.map(h => h.id)).size, 30);
  assert.equal(new Set(history.map(h => h.player.id)).size, 30, "Repeated player adds need manual reconciliation");
  assert.ok(history.every(h => h.removalTransactionId), "Expected subsequent cleanup evidence for every import");
  for (const a of state.assignments) {
    assert.equal(a.season, 2026);
    assert.equal(a.week, 1);
    a.week = 2;
  }
  assert.equal(state.changes.length, 1);
  for (const c of state.changes) {
    assert.equal(c.season, 2026);
    assert.equal(c.week, 1);
    c.week = 2;
  }
  state.week = 2;
  state.rosterHistory = history;
  return state;
}
