import { liveLeagueId, type Assignment, type Roster } from "./policy.ts";

export type DropClaim = {
  assignment_id: string; player_id: string; roster_id: number; status: string;
  created_at: string; transaction_id?: string | null;
};
type Operation = {
  id: string; worker: string; targets: Assignment[]; completed?: boolean;
  room?: unknown;
};
export type DropTransaction = {
  transaction_id?: string; type?: string; status?: string;
  drops?: Record<string, number> | null; adds?: Record<string, number> | null;
  created?: number;
};
export function dropMembership(a: Assignment, rosters: Roster[]) {
  const target = rosters.find(r => String(r.roster_id) === a.manager.id);
  if (!target) throw new Error(`Unknown roster for ${a.player.id}; commissioner review required.`);
  const owners = rosters.filter(r => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])].includes(a.player.id));
  if (owners.some(r => r !== target))
    throw new Error(`Player ${a.player.id} moved to another roster. Stopped for commissioner review; no transfer or drop from the new roster.`);
  return owners.length ? "present" : "absent";
}
export function exactDrop(t: DropTransaction, a: Assignment) {
  return typeof t.transaction_id === "string" && /^\d+$/.test(t.transaction_id)
    && t.type === "commissioner" && t.status === "complete"
    && Object.keys(t.adds ?? {}).length === 0 && Object.keys(t.drops ?? {}).length === 1
    && t.drops?.[a.player.id] === Number(a.manager.id);
}
export function dropMutation(a: Assignment) {
  if (!/^[1-9]\d{0,9}$/.test(a.player.id) || !/^[1-9]\d{0,3}$/.test(a.manager.id)
    || !["QB", "RB", "WR"].includes(a.player.position)) throw new Error("Invalid drop target.");
  return `mutation { league_create_transaction(type:"commissioner",league_id:"${liveLeagueId}",k_drops:[${JSON.stringify(a.player.id)}],v_drops:[${Number(a.manager.id)}]) { transaction_id type status leg adds drops roster_ids creator } }`;
}
export type CleanupServices = {
  phase: (phase: string, worker?: string, assignmentId?: string, transactionId?: string, evidence?: string) => Promise<unknown>;
  claims: (operationId: string) => Promise<DropClaim[]>;
  rosters: () => Promise<Roster[]>;
  drop: (a: Assignment) => Promise<DropTransaction>;
  transactions: () => Promise<DropTransaction[]>;
};

// One bounded server step, never one client-selected target. A durable operation
// locks all room commands across pauses; an expiring worker fences each request.
export async function cleanupStep(s: CleanupServices) {
  const op = await s.phase("acquire") as Operation;
  if (op.completed) return op;
  try {
    const claims = await s.claims(op.id);
    const snapshot = await s.rosters();
    // Preflight the ENTIRE outgoing set before making even the first drop.
    for (const a of op.targets) dropMembership(a, snapshot);
    const pending = op.targets.find(a => !claims.some(c => c.assignment_id === a.id && c.status === "verified"));
    const done = claims.filter(c => c.status === "verified").length;
    if (!pending) {
      if (op.targets.some(a => dropMembership(a, snapshot) !== "absent"))
        throw new Error("A cleaned player is back on a roster. Commissioner review required; week not advanced.");
      return await s.phase("finish", op.worker);
    }
    const a = pending;
    const existing = claims.find(c => c.assignment_id === a.id);
    if (existing) {
      // An old uncertain claim may already have sent a mutation. Never send again.
      const transactions = await s.transactions();
      const matches = transactions.filter(t => exactDrop(t, a) && typeof t.created === "number"
        && t.created >= Date.parse(existing.created_at));
      if (matches.length !== 1 || dropMembership(a, await s.rosters()) !== "absent")
        throw new Error(`Drop outcome for ${a.player.id} is uncertain. No retry sent; commissioner review required. Resume only to reconcile.`);
      await s.phase("verify", op.worker, a.id, matches[0].transaction_id, "transaction");
    } else {
      const before = dropMembership(a, await s.rosters());
      await s.phase("claim", op.worker, a.id);
      // Recheck latest permission + worker fence immediately before the mutation.
      const latest = dropMembership(a, await s.rosters());
      await s.phase("authorize", op.worker, a.id);
      if (before === "absent" && latest === "absent") {
        await s.phase("verify", op.worker, a.id, undefined, "already-absent");
      } else if (latest === "absent") {
        await s.phase("verify", op.worker, a.id, undefined, "already-absent");
      } else {
        let transaction: DropTransaction | undefined;
        try { transaction = await s.drop(a); } catch { /* Reconcile, never retry a transport failure. */ }
        if (!transaction || !exactDrop(transaction, a)) {
          const claim = (await s.claims(op.id)).find(c => c.assignment_id === a.id)!;
          const matches = (await s.transactions()).filter(t => exactDrop(t, a)
            && typeof t.created === "number" && t.created >= Date.parse(claim.created_at));
          if (matches.length === 1) transaction = matches[0];
        }
        if (!transaction || !exactDrop(transaction, a) || dropMembership(a, await s.rosters()) !== "absent")
          throw new Error(`Drop outcome for ${a.player.id} is unverified. Week not advanced; no automatic mutation retry.`);
        await s.phase("verify", op.worker, a.id, transaction.transaction_id, "transaction");
      }
    }
    return { completed: false, done: done + 1, total: op.targets.length };
  } catch (error) {
    try { await s.phase("flag", op.worker, undefined, undefined, error instanceof Error ? error.message : "Commissioner review required."); } catch { /* The original error remains actionable. */ }
    throw error;
  } finally {
    // An expired worker cannot release another worker's lease.
    try { await s.phase("release", op.worker); } catch { /* Durable lease expires; claims remain. */ }
  }
}
