"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { autoWheelDelayMs, nextWheel, type WheelCommand } from "@/lib/auto-wheel";
import { type GameState } from "@/lib/game";
import "./auto-wheel.css";

type Props = {
    game: GameState;
    canEdit: boolean;
    busy: boolean;
    spinning: boolean;
    suspended: boolean;
    error: string;
    onSpin: (command: WheelCommand) => Promise<boolean | undefined>;
};

export function AutoWheel(props: Props) {
    const next = nextWheel(props.game);
    let reason = "";
    if (!props.canEdit)
        reason = "Commissioner controls only.";
    else if (props.error)
        reason = "Stopped. Fix the error to resume.";
    else if (props.suspended)
        reason = "Paused.";
    else if (!next)
        reason = props.game.locked.length
            ? props.spinning ? "Last spin. Round 2 is yours." : "Round 1 done. Round 2 is yours."
            : "Lock a player pool first.";

    return <section className="panel auto-wheel">
        {reason || !next
            ? <><label className="auto-wheel-toggle"><input type="checkbox" role="switch" aria-label="Auto-mode" checked={false} disabled /> Auto-mode</label><p role="status">{reason}</p></>
            : <AutoWheelRunner key={`${props.game.season}:${props.game.week}`} {...props} next={next} />}
    </section>;
}

function AutoWheelRunner({ game, busy, spinning, next, onSpin }: Props & {
    next: NonNullable<ReturnType<typeof nextWheel>>;
}) {
    const [enabled, setEnabled] = useState(false);
    const stepKey = `${game.lastSpin?.id ?? "start"}:${JSON.stringify(next.command)}`;
    async function advance() {
        if (!await onSpin(next.command))
            setEnabled(false);
    }
    return <>
        <label className="auto-wheel-toggle"><input type="checkbox" role="switch" aria-label="Auto-mode" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Auto-mode</label>
        {enabled && !busy && !spinning
            ? <AutoCountdown key={stepKey} label={next.label} onComplete={advance} />
            : <p role="status">{enabled ? "Spinning..." : "Players only. 3 seconds between spins."}</p>}
    </>;
}

function AutoCountdown({ label, onComplete }: { label: string; onComplete: () => Promise<void> }) {
    const [remaining, setRemaining] = useState(autoWheelDelayMs / 1000);
    const finish = useEffectEvent(onComplete);
    useEffect(() => {
        const deadline = Date.now() + autoWheelDelayMs;
        const timer = window.setInterval(() => {
            const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            setRemaining(seconds);
            if (seconds === 0) {
                window.clearInterval(timer);
                void finish();
            }
        }, 100);
        return () => window.clearInterval(timer);
    }, []);
    return <p role="status">Next: {label} in <strong>{remaining}</strong>...</p>;
}
