"use client";

import { useRef, useState } from "react";
import type { CommissionerChange, RoomAccess } from "@/components/use-room-access";
import "./room-commissioners.css";

export function RoomCommissioners({ access, onChange }: {
    access: RoomAccess | null;
    onChange: (change: CommissionerChange) => Promise<void>;
}) {
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const inFlight = useRef(false);

    async function change(value: CommissionerChange) {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await onChange(value);
            if (value.action === "add") {
                setEmail("");
                setNotice("Commissioner added. They can sign in at this same room link.");
            } else {
                setNotice("Commissioner access removed.");
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not update commissioner access. Refresh before retrying.");
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    if (!access)
        return <p>Room permissions are not available yet. Editing stays disabled until they load.</p>;
    if (!access.isOwner)
        return <p>{access.canEdit
            ? "You are a co-commissioner and can operate all room controls. Only the room creator can manage commissioner access."
            : "You are watching as a spectator. Ask the room creator to add your account email as a commissioner."}</p>;

    return <section className="room-commissioners" aria-labelledby="commissioners-heading">
        <h3 id="commissioners-heading">Room commissioners ({access.commissioners.length + 1})</h3>
        <p>You are the room creator. Add existing, confirmed accounts by email. Every commissioner can operate the wheels and edit the league; only you can manage access.</p>
        <ul className="commissioner-list">
            <li><span><strong>You</strong><small>Room creator - cannot be removed</small></span></li>
            {access.commissioners.map(member => <li key={member.userId}>
                <span>{member.email}</span>
                <button type="button" className="text-button danger" disabled={busy} aria-label={`Remove commissioner ${member.email}`} onClick={() => {
                    if (window.confirm(`Remove commissioner access for ${member.email}? They will still be able to watch this public room.`))
                        void change({ action: "remove", userId: member.userId });
                }}>Remove</button>
            </li>)}
        </ul>
        <form className="login-form" onSubmit={event => { event.preventDefault(); void change({ action: "add", email: email.trim() }); }}>
            <label>Commissioner email<input type="email" required maxLength={254} autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
            <button className="button dark" disabled={busy || !email.trim()}>{busy ? "Saving..." : "Add commissioner"}</button>
        </form>
        <p className="small-print">No invitation email is sent. Share this room&apos;s link and have them sign in with their own account. Commissioner emails are visible only to you.</p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
    </section>;
}
