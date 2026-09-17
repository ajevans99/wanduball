import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { liveLeagueId, liveRoomId, parseRosters, rosterStatus, type Assignment } from "./policy.ts";
import { cleanupStep, dropMutation, dropMembership, type DropTransaction } from "./cleanup.ts";

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
class Failure extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const required = (key: string) => {
  const value = Deno.env.get(key);
  if (!value) throw new Failure(503, "Sleeper integration is unavailable.");
  return value;
};
async function graphql(query: string) {
  const result = await fetch("https://sleeper.com/graphql", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: required("SLEEPER_SESSION_TOKEN") },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(12_000),
  });
  if (!result.ok) throw new Failure(503, "Sleeper is unavailable. Refresh status; do not retry an add.");
  const body = await result.json();
  if (body.errors?.length || !body.data) throw new Failure(503, "Sleeper did not confirm the operation. Refresh status; do not retry an add.");
  return body.data;
}
async function rosters() {
  const data = await graphql(`query { me { user_id } league_rosters(league_id:"${liveLeagueId}") { league_id roster_id players reserve taxi } }`);
  if (String(data.me?.user_id) !== required("SLEEPER_USER_ID") || required("SLEEPER_USER_ID") !== "996938453788999680")
    throw new Failure(503, "Sleeper session account does not match the configured commissioner.");
  return parseRosters(data.league_rosters);
}

Deno.serve(async request => {
  try {
    if (request.method !== "POST") throw new Failure(405, "POST required.");
    if (required("SLEEPER_LEAGUE_ID") !== liveLeagueId) throw new Failure(503, "Sleeper league configuration mismatch.");
    const authorization = request.headers.get("authorization");
    const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new Failure(401, "Sign in as a room commissioner.");
    const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(12_000) }) },
    });
    const user = await db.auth.getUser(token);
    if (user.error || !user.data.user) throw new Failure(401, "Sign in again.");
    const userId = user.data.user.id;
    const body = await request.json();
    const cleanup = ["cleanup-preview", "cleanup-step"].includes(body?.action);
    if (!body || body.roomId !== liveRoomId || !["status", "apply", "cleanup-preview", "cleanup-step"].includes(body.action)
      || Object.keys(body).some(k => !(cleanup ? ["roomId", "action", "season", "week", "version"] : ["roomId", "action", "assignmentId"]).includes(k))
      || (body.action === "apply" && typeof body.assignmentId !== "string")
      || (body.action === "status" && body.assignmentId !== undefined)
      || (cleanup && ![body.season, body.week, body.version].every(Number.isSafeInteger)))
      throw new Failure(400, "Invalid single-player request or unbound room.");
    const access = await db.rpc("room_commissioner_access", { p_room_id: liveRoomId, p_user_id: userId });
    if (access.error) throw new Failure(503, "Room authorization unavailable.");
    if (!access.data?.canEdit) throw new Failure(403, "Only room commissioners may query or apply Sleeper status.");
    const [room, binding, claims] = await Promise.all([
      db.from("rooms").select("state,version").eq("id", liveRoomId).single(),
      db.from("sleeper_room_bindings").select("*").eq("room_id", liveRoomId).single(),
      db.from("sleeper_apply_claims").select("*").eq("room_id", liveRoomId),
    ]);
    if (room.error || binding.error || claims.error) throw new Failure(503, "Sleeper integration storage unavailable.");
    if (binding.data.league_id !== liveLeagueId || room.data.state.leagueId !== liveLeagueId)
      throw new Failure(409, "Room league does not match its approved binding.");
    if (cleanup) {
      const phase = async (phase: string, worker?: string, assignmentId?: string, transactionId?: string, evidence?: string) => {
        const result = await db.rpc("sleeper_cleanup_step", {
          p_room_id: liveRoomId, p_user_id: userId, p_season: body.season, p_week: body.week,
          p_version: body.version, p_phase: phase, p_worker: worker,
          p_assignment_id: assignmentId, p_transaction_id: transactionId, p_evidence: evidence,
        });
        if (result.error) throw new Failure(result.error.code === "PT403" ? 403 : 409, result.error.message);
        return result.data;
      };
      if (body.action === "cleanup-preview") {
        const preview = await phase("preview");
        const snapshot = await rosters();
        for (const a of preview.targets ?? []) dropMembership(a, snapshot);
        return response({ ...preview, count: preview.targets?.length ?? 0 });
      }
      return response(await cleanupStep({
        phase, rosters,
        claims: async id => {
          const result = await db.from("sleeper_drop_claims").select("*").eq("cleanup_id", id);
          if (result.error) throw new Failure(503, "Cleanup audit unavailable.");
          return result.data;
        },
        drop: async a => (await graphql(dropMutation(a))).league_create_transaction,
        transactions: async () => {
          // The room week can differ from Sleeper's current transaction leg.
          // Search all regular-season legs only for uncertain outcome recovery.
          const results = await Promise.all(Array.from({ length: 18 }, async (_, i) => {
            const result = await fetch(`https://api.sleeper.app/v1/league/${liveLeagueId}/transactions/${i + 1}`,
              { signal: AbortSignal.timeout(10_000) });
            if (!result.ok) throw new Failure(503, "Drop transaction reconciliation unavailable.");
            const data = await result.json();
            if (!Array.isArray(data)) throw new Failure(503, "Invalid transaction evidence.");
            return data as DropTransaction[];
          }));
          return [...new Map(results.flat().map(t => [t.transaction_id, t])).values()];
        },
      }));
    }
    const cleanupState = await db.from("sleeper_cleanups").select("*").eq("room_id", liveRoomId);
    if (cleanupState.error) throw new Failure(503, "Cleanup lock status unavailable.");
    if (cleanupState.data?.some(op => op.status === "active")) {
      if (body.action === "status") return response({ cleanupActive: true, checkedAt: new Date().toISOString(), assignments: {} });
      throw new Failure(409, "Weekly cleanup is active. Adds and status application are paused; use Open next week to resume cleanup.");
    }
    const assignments: Assignment[] = room.data.state.assignments;
    const current = (a: Assignment) => room.data.state.season === 2026
      && a.season === room.data.state.season && a.week === room.data.state.week
      && a.week >= 2;
    let snapshot = await rosters();
    if (body.action === "apply") {
      const matches = assignments.filter(a => a.id === body.assignmentId);
      if (matches.length !== 1) throw new Failure(422, "Stored assignment not found or ambiguous.");
      const a = matches[0];
      const existing = claims.data.find(c => c.player_id === a.player.id && (c.assignment_id === a.id || c.status === "uncertain"));
      const status = rosterStatus(a, snapshot, Boolean(existing), current(a));
      const spin = room.data.state.lastSpin;
      const paired = (a as Assignment & { awardedWithSpinId?: string }).awardedWithSpinId;
      if (!current(a) || a.dropped || !["QB", "RB", "WR"].includes(a.player.position)
        || (spin && (a.id === spin.id || paired === spin.id) && Date.now() < spin.startedAt + 5000))
        throw new Failure(409, "Apply blocked: only revealed assignments in the current live round may be applied.");
      if (status.status === "applied" && existing) {
        const saved = await db.rpc("verify_sleeper_player", { p_claim_id: existing.id, p_user_id: userId });
        if (saved.error) throw new Failure(503, "Roster verified, but audit update failed. Refresh status to recover.");
      } else {
        // Even a no-op must be eligible: dropped/history/disabled positions never trigger adds.
        if ((!status.canApply && status.status !== "applied") || a.dropped || !current(a)
          || !["QB", "RB", "WR"].includes(a.player.position))
          throw new Failure(409, `Apply blocked: ${status.status}. No roster changes made.`);
        // Validate real NFL player identity, not merely a numeric practice ID.
        const playerResponse = await fetch(`https://api.sleeper.app/v1/players/nfl/${a.player.id}`, { signal: AbortSignal.timeout(10_000) });
        if (!playerResponse.ok) throw new Failure(503, "Player identity verification unavailable.");
        const player = await playerResponse.json();
        if (String(player?.player_id) !== a.player.id || player.position !== a.player.position)
          throw new Failure(422, "Stored assignment is not a verified NFL player.");
        const claim = await db.rpc("claim_sleeper_player", {
          p_room_id: liveRoomId, p_user_id: userId, p_assignment_id: a.id, p_version: room.data.version,
        });
        if (claim.error || !claim.data) throw new Failure(409, "Room changed or an add was already claimed. Refresh status; no retry.");
        let transactionId: string | null = null;
        // Re-read after acquiring the claim: never transfer a player who moved
        // while authorization, identity checks, or the DB lock were pending.
        snapshot = await rosters();
        const beforeWrite = rosterStatus(a, snapshot, false, current(a));
        if (beforeWrite.status !== "applied" && !beforeWrite.canApply)
          throw new Failure(409, "Roster changed while claiming. No add was sent; verification is required.");
        if (beforeWrite.status !== "applied") {
          // Exactly one mutation, add-only. No transport retries, drops, transfers or lineup edits.
          try {
            const result = await graphql(`mutation { league_create_transaction(type:"commissioner",league_id:"${liveLeagueId}",k_adds:[${JSON.stringify(a.player.id)}],v_adds:[${Number(a.manager.id)}]) { transaction_id type status leg adds drops roster_ids creator } }`);
            transactionId = result.league_create_transaction?.transaction_id ?? null;
          } catch {
            // A timeout can mean success. Independent membership verification is the only recovery.
          }
        }
        snapshot = await rosters();
        if (rosterStatus(a, snapshot, true, current(a)).status !== "applied")
          throw new Failure(409, "Add outcome is unverified. The durable claim blocks retries. Refresh status or inspect Sleeper manually.");
        const saved = await db.rpc("verify_sleeper_player", {
          p_claim_id: claim.data.id, p_user_id: userId, p_transaction_id: transactionId,
        });
        if (saved.error) throw new Failure(503, "Roster verified, but audit update failed. Refresh status to recover.");
      }
    }
    // Recover a write whose response or DB save was lost, without issuing another mutation.
    for (const claim of claims.data) {
      const a = assignments.find(a => a.id === claim.assignment_id);
      if (a && claim.status !== "verified" && rosterStatus(a, snapshot, true, current(a)).status === "applied") {
        const saved = await db.rpc("verify_sleeper_player", { p_claim_id: claim.id, p_user_id: userId });
        if (saved.error) throw new Failure(503, "Roster verification succeeded but audit recovery is unavailable.");
      }
    }
    const observed = await db.rpc("observe_sleeper_players", {
      p_room_id: liveRoomId, p_user_id: userId, p_version: room.data.version,
      p_present_ids: assignments.filter(a => rosterStatus(a, snapshot, false, current(a)).status === "applied").map(a => a.id),
    });
    if (observed.error) throw new Failure(503, "Roster observation could not be saved. Refresh status to recover.");
    return response({
      checkedAt: new Date().toISOString(),
      assignments: Object.fromEntries(assignments.map(a => [a.id, rosterStatus(a, snapshot,
        claims.data.some(c => c.player_id === a.player.id && (c.assignment_id === a.id || c.status === "uncertain"))
          || (body.action === "apply" && a.id === body.assignmentId), current(a))])),
    });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Sleeper status unavailable. No automatic retries; refresh status to verify." },
      error instanceof Failure ? error.status : 503);
  }
});
