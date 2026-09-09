"use client";

import { useState } from "react";
import { nicknameMaxLength } from "@/lib/game";
import "./player-nicknames.css";

export function PlayerNicknameEditor({ playerName, nickname, disabled, onSave }: {
    playerName: string;
    nickname: string;
    disabled: boolean;
    onSave: (nickname: string) => Promise<boolean | undefined>;
}) {
    const [draft, setDraft] = useState(nickname);
    return <form className="player-nickname-editor" onSubmit={async event => {
        event.preventDefault();
        if (!disabled && await onSave(draft.trim()))
            setDraft(draft.trim());
    }}>
        <input aria-label={`Nickname for ${playerName}`} placeholder="Add a nickname"
            value={draft} maxLength={nicknameMaxLength} disabled={disabled}
            onChange={event => setDraft(event.target.value)} />
        <button type="submit" disabled={disabled || draft.trim() === nickname}
            aria-label={`Save nickname for ${playerName}`}>Save</button>
        {nickname && <button type="button" disabled={disabled}
            aria-label={`Clear nickname for ${playerName}`}
            onClick={async () => { if (!disabled && await onSave("")) setDraft(""); }}>Clear</button>}
    </form>;
}
