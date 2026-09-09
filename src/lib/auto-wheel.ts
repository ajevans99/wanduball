import { currentAssignments, isCurrent, pool, positions, type Command, type GameState } from "./game.ts";

export const autoWheelDelayMs = 3000;
export type WheelCommand = Extract<Command, { type: "assign" | "coin" | "rule" | "points" }>;

export function nextWheel(state: GameState): { command: WheelCommand; label: string } | null {
    if (state.changes.some(change => isCurrent(state, change)))
        return null;
    if (state.pending.ruleId)
        return state.rules.some(rule => rule.id === state.pending.ruleId)
            ? { command: { type: "points" }, label: "the points wheel" } : null;
    if (state.pending.duration)
        return state.rules.some(rule => rule.duration === state.pending.duration)
            ? { command: { type: "rule" }, label: "the rule wheel" } : null;
    if (!state.locked.length)
        return null;
    for (const position of positions.filter(position => state.locked.includes(position))) {
        const assigned = currentAssignments(state, position);
        if (assigned.length === 10)
            continue;
        const hasPlayer = pool(state, position).some(player => !assigned.some(a => a.player.id === player.id));
        const hasManager = state.managers.some(manager => !assigned.some(a => a.manager.id === manager.id));
        return hasPlayer && hasManager
            ? { command: { type: "assign", position }, label: `the ${position} player wheel` } : null;
    }
    return { command: { type: "coin" }, label: "the duration coin" };
}
