"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { GameState } from "@/lib/game";
import { requestJson, supabase } from "@/lib/browser";
import "./sleeper-assignments.css";
import { committedSpinBatch, sleeperLiveRoomId } from "@/lib/sleeper-auto";

export { sleeperLiveRoomId } from "@/lib/sleeper-auto";
type Status = { status: string; canApply: boolean };
type Result = { checkedAt: string; assignments: Record<string, Status>; cleanupActive?: boolean };
export function useSleeperAssignments(roomId: string | null, active: boolean, canEdit: boolean, version: number) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const stopRequested = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const automaticInFlight = useRef(false);
  const [autoBatch, setAutoBatch] = useState<ReturnType<typeof committedSpinBatch>>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const permissions = useRef(canEdit);
  useEffect(() => { permissions.current = canEdit; }, [canEdit]);
  const invalidate = useCallback(() => { ++sequence.current; }, []);
  const linked = roomId === sleeperLiveRoomId;
  useEffect(() => {
    return () => { stopRequested.current = true; };
  }, [roomId, canEdit]);
  useEffect(() => {
    return () => { if (!automaticInFlight.current) stopRequested.current = true; };
  }, [active]);
  const invoke = useCallback(async (assignmentId?: string) => {
    if (!supabase) throw new Error("Sign in as a commissioner to verify roster membership.");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error("Sign in again to verify roster membership.");
    return requestJson<Result>("/api/room/sleeper", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ roomId, action: assignmentId ? "apply" : "status", ...(assignmentId ? { assignmentId } : {}) }),
    });
  }, [roomId]);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const id = ++sequence.current;
    setResult(null);
    setError("");
    try {
      const result = await invoke();
      if (id === sequence.current) setResult(result);
    } catch (error) {
      if (id === sequence.current) setError(error instanceof Error ? error.message : "Status unavailable.");
    }
  }, [invoke]);
  useEffect(() => {
    if (!linked || !active || !canEdit) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    window.addEventListener("focus", refresh);
    return () => { invalidate(); window.clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [linked, active, canEdit, version, refresh, invalidate]);
  const applyAll = async (assignments: GameState["assignments"], automatic = false) => {
    if (inFlight.current || result?.cleanupActive || !canEdit || (!active && !automatic) || !linked
      || (!automatic && autoBatch && !autoPaused)) return;
    const eligible = automatic ? assignments : assignments.filter(a => result?.assignments[a.id]?.canApply);
    if (!eligible.length) return;
    inFlight.current = true;
    automaticInFlight.current = automatic;
    stopRequested.current = false;
    ++sequence.current;
    setWorking(true);
    setError("");
    let completed = 0;
    try {
      let latest = await invoke();
      setResult(latest);
      if (latest.cleanupActive) throw new Error("Weekly cleanup active. Resume cleanup before adding players.");
      for (const a of eligible) {
        if (stopRequested.current || !permissions.current) throw new Error("Stopped. Verify roster status before resuming.");
        if (latest.assignments[a.id]?.status === "applied") { completed++; continue; }
        if (!latest.assignments[a.id]?.canApply)
          throw new Error(`${a.player.name} is no longer eligible. Stopped; refresh status before continuing.`);
        setProgress(`Applying ${completed + 1} of ${eligible.length}...`);
        latest = await invoke(a.id);
        setResult(latest);
        if (latest.assignments[a.id]?.status !== "applied")
          throw new Error(`${a.player.name} could not be verified. Stopped; refresh status before continuing.`);
        completed++;
      }
      setProgress(`${stopRequested.current ? "Stopped. " : ""}${completed} applied.`);
      if (automatic) setAutoBatch(null);
    }
    catch (error) {
      setResult(null);
      setProgress(`Stopped after ${completed} applied.`);
      setError(error instanceof Error ? error.message : "Outcome unknown. Refresh status; do not retry.");
      if (automatic) setAutoPaused(true);
    }
    finally { inFlight.current = false; automaticInFlight.current = false; setWorking(false); }
  };
  const committedSpin = (before: GameState, after: GameState) => {
    if (!canEdit || result?.cleanupActive || !autoEnabled || autoPaused) return;
    const batch = committedSpinBatch(roomId, before, after);
    if (batch) {
      setAutoBatch(batch);
      setProgress("Waiting for the wheel reveal before adding to Sleeper.");
    }
  };
  const runAutomatic = useEffectEvent((assignments: GameState["assignments"]) => applyAll(assignments, true));
  useEffect(() => {
    if (!autoBatch || autoPaused || !canEdit) return;
    const timer = window.setTimeout(() => void runAutomatic(autoBatch.assignments),
      Math.max(0, autoBatch.revealAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [autoBatch, autoPaused, canEdit]);
  useEffect(() => {
    if (!autoBatch || canEdit) return;
    const timer = window.setTimeout(() => {
      setAutoPaused(true);
      setError("Commissioner access changed. Sign in and deliberately resume roster verification.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoBatch, canEdit]);
  const apply = (a: GameState["assignments"][number]) => applyAll([a]);
  const stop = () => { stopRequested.current = true; };
  return { linked, result: canEdit ? result : null, error, working, refresh, apply, applyAll, progress, stop,
    committedSpin, autoPaused, autoEnabled, setAutoEnabled, autoPending: Boolean(autoBatch), cleanupActive: Boolean(result?.cleanupActive),
    resumeAuto: () => { setError(""); setAutoPaused(false); } };
}

const labels: Record<string, string> = {
  applied: "Applied · verified", absent: "Not on roster", conflict: "On another team · blocked",
  dropped: "Absent · previously dropped", ineligible: "Absent · ineligible",
  "invalid-roster": "Unknown roster · blocked", "verification-required": "Unverified outcome · retry blocked",
};
export function SleeperAssignmentCell({ status, disabled, apply }: {
  status?: Status; disabled: boolean; apply: () => void;
}) {
  return <div className="sleeper-assignment-cell"><span>{status ? labels[status.status] ?? "Status unavailable" : "Status unavailable"}</span>
    {status?.canApply && <button className="check-button" disabled={disabled} onClick={apply}>Apply this player</button>}
  </div>;
}
