"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson, supabase } from "@/lib/browser";
import type { Session } from "@supabase/supabase-js";

export type RoomAccess = {
    canEdit: boolean;
    isOwner: boolean;
    commissioners: { userId: string; email: string }[];
};
export type CommissionerChange =
    | { action: "add"; email: string }
    | { action: "remove"; userId: string };

async function fetchAccess(roomId: string, userId: string) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session || data.session.user.id !== userId)
        throw new Error("Sign in again to confirm your room permissions.");
    return requestJson<RoomAccess>(`/api/room/commissioners?room=${encodeURIComponent(roomId)}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
    });
}

export function useRoomAccess(roomId: string | null, session: Session | null, onError: (message: string) => void) {
    const userId = session?.user.id;
    const token = session?.access_token;
    const [result, setResult] = useState<{ roomId: string; token: string; access: RoomAccess } | null>(null);
    const requestId = useRef(0);
    const access = result?.roomId === roomId && result?.token === token ? result.access : null;
    const invalidate = useCallback(() => { ++requestId.current; }, []);

    const refreshAccess = useCallback(() => {
        const id = ++requestId.current;
        if (!roomId || !userId || !token)
            return Promise.resolve();
        return fetchAccess(roomId, userId).then(access => {
            if (requestId.current === id)
                setResult({ roomId, token, access });
        }).catch((error: unknown) => {
            if (requestId.current === id) {
                setResult(null);
                onError(error instanceof Error ? error.message : "Unable to confirm room permissions. Editing is disabled.");
            }
        });
    }, [roomId, userId, token, onError]);

    useEffect(() => {
        void refreshAccess();
        if (!roomId || !userId)
            return;
        const interval = window.setInterval(refreshAccess, 15000);
        window.addEventListener("focus", refreshAccess);
        return () => {
            invalidate();
            window.clearInterval(interval);
            window.removeEventListener("focus", refreshAccess);
        };
    }, [roomId, userId, refreshAccess, invalidate]);

    const changeCommissioner = useCallback(async (change: CommissionerChange) => {
        if (!roomId || !userId || !supabase)
            throw new Error("Sign in as the room creator to manage commissioners.");
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!data.session || data.session.user.id !== userId)
            throw new Error("Sign in again to manage commissioners.");
        try {
            await requestJson<RoomAccess>("/api/room/commissioners", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
                body: JSON.stringify({ roomId, ...change }),
            });
            await refreshAccess();
        } catch (error) {
            await refreshAccess();
            throw error;
        }
    }, [roomId, userId, refreshAccess]);

    return { access, refreshAccess, changeCommissioner };
}
