"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { autoWheelDelayMs, nextWheel, type WheelCommand } from "@/lib/auto-wheel";
import { isCurrent, type GameState } from "@/lib/game";
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
    const complete = props.game.changes.some(change => isCurrent(props.game, change));
    let reason = "";
    if (!props.canEdit)
        reason = "The commissioner operates auto-mode. Spectators just enjoy the damage.";
    else if (props.error)
        reason = "Auto-mode stopped. Resolve the error, then switch it back on.";
    else if (props.suspended)
        reason = "Auto-mode stopped while a dialog is open.";
    else if (!next)
        reason = complete
            ? props.spinning ? "Finishing the final wheel. Then the paperwork is yours." : "This week's wheels are done. Sleeper changes and cleanup stay manual."
            : "No eligible wheel. Review and lock your player pools, and check the rulebook.";

    return <section className="panel auto-wheel">
        <h3>Let the nonsense drive.</h3>
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
        <label className="auto-wheel-toggle"><input type="checkbox" role="switch" aria-label="Auto-mode" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Auto-mode <span>{enabled ? "CHAOS CRUISE CONTROL" : "YOU'RE DRIVING"}</span></label>
        {enabled && !busy && !spinning
            ? <AutoCountdown key={stepKey} label={next.label} onComplete={advance} />
            : <p role="status">{enabled ? "Letting this result land. The next wheel follows automatically." : "A 3-second breather between wheels. All locked pools, then coin, rule, points."}</p>}
        <small>Off cancels the next spin, not the one already rolling. Leaving this room or reloading switches auto-mode off.</small>
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
