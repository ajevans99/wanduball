import { z } from "zod";
export const positions = ["QB", "RB", "WR", "TE"] as const;
export const enabledPositions: readonly Position[] = ["QB", "RB", "WR"];
export const positionSchema = z.enum(positions);
export type Position = z.infer<typeof positionSchema>;
export const pointsWheel = [90, 40, 1, 2, 4, 5, 8, 10, -8, -5, -4, -2, -1, -40, -90];
export const spinDurationMs = 5000;
export const assignmentLeadInMs = 3000;
export const nicknameMaxLength = 40;
const nicknameSchema = z.string().trim().max(nicknameMaxLength);
export const playerSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: positionSchema,
    team: z.string(),
    points: z.number().finite(),
    injury: z.string().nullable(),
});
export type Player = z.infer<typeof playerSchema>;
export const ruleSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(80),
    duration: z.enum(["Weekly", "Permanent"]),
    baseline: z.number().finite(),
});
export type Rule = z.infer<typeof ruleSchema>;
export const managerSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(100) });
const assignmentSchema = z.object({
    id: z.string(), week: z.number().int(), season: z.number().int(),
    player: playerSchema, manager: managerSchema,
    nickname: nicknameSchema.min(1).optional(),
    awardedWithSpinId: z.string().optional(),
    applied: z.boolean(), dropped: z.boolean(),
});
const changeSchema = z.object({
    id: z.string(), week: z.number().int(), season: z.number().int(),
    rule: ruleSchema, previous: z.number(), value: z.number(),
    applied: z.boolean(), reverted: z.boolean(),
});
export const stateSchema = z.object({
    season: z.number().int().min(2020).max(2100),
    week: z.number().int().min(1).max(18),
    leagueId: z.string(),
    managers: z.array(managerSchema).min(1).max(20),
    players: z.array(playerSchema),
    // Kept separately from imported players so a weekly pool reset doesn't erase nicknames.
    nicknames: z.record(z.string(), nicknameSchema.min(1)).optional(),
    excluded: z.array(z.string()),
    locked: z.array(positionSchema),
    assignments: z.array(assignmentSchema),
    rules: z.array(ruleSchema).min(1),
    changes: z.array(changeSchema),
    pending: z.object({
        duration: z.enum(["Weekly", "Permanent"]).nullable(),
        ruleId: z.string().nullable(),
    }),
    lastSpin: z.object({
        id: z.string(), label: z.string(), detail: z.string(),
        startedAt: z.number(), index: z.number().int(), options: z.array(z.string()),
        sliceLabels: z.array(z.string()).optional(),
    }).nullable(),
    source: z.string(),
});
export type GameState = z.infer<typeof stateSchema>;
export const commandSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("nickname"), playerId: z.string().min(1), nickname: nicknameSchema }),
    z.object({ type: z.literal("exclude"), playerId: z.string() }),
    z.object({ type: z.literal("lock"), position: positionSchema }),
    z.object({ type: z.literal("assign"), position: positionSchema }),
    z.object({ type: z.literal("coin") }),
    z.object({ type: z.literal("rule") }),
    z.object({ type: z.literal("points") }),
    z.object({ type: z.literal("assignment-status"), id: z.string(), field: z.enum(["applied", "dropped"]) }),
    z.object({ type: z.literal("change-status"), id: z.string(), field: z.enum(["applied", "reverted"]) }),
    z.object({ type: z.literal("next-week") }),
    z.object({ type: z.literal("add-rule"), rule: ruleSchema }),
    z.object({
        type: z.literal("import"), players: z.array(playerSchema).min(1),
        season: z.number().int().min(2020).max(2100),
        week: z.number().int().min(1).max(18), leagueId: z.string(),
        managers: z.array(managerSchema).min(1).max(20), source: z.string(),
        baselines: z.record(z.string(), z.number().finite()).optional(),
    }),
]);
export type Command = z.infer<typeof commandSchema>;
export function playerLabel(player: Player, nickname?: string) {
    return nickname ? `${nickname} (${player.name})` : player.name;
}
export function pool(state: GameState, position: Position) {
    return state.players.filter(p => p.position === position && !state.excluded.includes(p.id))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, 10);
}
export function isCurrent(state: GameState, item: {
    week: number;
    season: number;
}) {
    return item.week === state.week && item.season === state.season;
}
export function currentAssignments(state: GameState, position?: Position) {
    return state.assignments.filter(a => isCurrent(state, a) && (!position || a.player.position === position));
}
export function hasCleanup(state: GameState) {
    return state.assignments.some(a => !a.dropped)
        || state.changes.some(c => c.rule.duration === "Weekly" && !c.reverted)
        || state.changes.some(c => c.rule.duration === "Permanent" && !c.applied);
}
// A single transition function is used by local practice and the authoritative server.
export function transition(state: GameState, command: Command, random: (max: number) => number, now = Date.now()): GameState {
    const s = structuredClone(state);
    const id = crypto.randomUUID();
    const spinning = s.lastSpin && now < s.lastSpin.startedAt + spinDurationMs;
    const spin = (options: string[], detail: string, leadInMs = 1000) => {
        if (!options.length)
            throw new Error("This wheel has no eligible entries.");
        const index = random(options.length);
        s.lastSpin = { id, label: options[index], detail, options, index, startedAt: now + leadInMs };
        return index;
    };
    if (spinning)
        throw new Error("Let the wheel finish its very important business.");
    switch (command.type) {
        case "nickname": {
            if (!s.players.some(p => p.id === command.playerId))
                throw new Error("Player not found.");
            const nickname = nicknameSchema.parse(command.nickname);
            s.nicknames ??= {};
            if (nickname)
                s.nicknames[command.playerId] = nickname;
            else
                delete s.nicknames[command.playerId];
            break;
        }
        case "exclude": {
            const player = s.players.find(p => p.id === command.playerId);
            if (!player)
                throw new Error("Player not found.");
            if (s.locked.includes(player.position))
                throw new Error("This position's pool is already locked.");
            s.excluded = s.excluded.includes(player.id) ? s.excluded.filter(i => i !== player.id) : [...s.excluded, player.id];
            break;
        }
        case "lock":
            if (!enabledPositions.includes(command.position))
                throw new Error("Tight end assignments are disabled for now.");
            if (s.pending.duration || s.changes.some(c => isCurrent(s, c)))
                throw new Error("The scoring round has started. New player pools must wait until next week.");
            if (s.locked.includes(command.position))
                throw new Error("Pool already locked.");
            if (pool(s, command.position).length !== 10 || s.managers.length !== 10)
                throw new Error("You need 10 eligible players and 10 managers to lock this pool.");
            s.locked.push(command.position);
            break;
        case "assign": {
            if (!enabledPositions.includes(command.position))
                throw new Error("Tight end assignments are disabled for now.");
            if (s.pending.duration || s.changes.some(c => isCurrent(s, c)))
                throw new Error("The scoring round has started. Player assignments are closed for this week.");
            if (!s.locked.includes(command.position))
                throw new Error("Review and lock this position in Weekly Setup first.");
            const assigned = currentAssignments(s, command.position);
            const players = pool(s, command.position).filter(p => !assigned.some(a => a.player.id === p.id));
            const managers = s.managers.filter(m => !assigned.some(a => a.manager.id === m.id));
            if (!players.length || !managers.length)
                throw new Error("All players in this position have a home. Unfortunately.");
            if (players.length === 1 && managers.length === 1) {
                const player = players[0];
                const manager = managers[0];
                const nickname = s.nicknames?.[player.id];
                s.assignments.push({ id, week: s.week, season: s.season, manager, player, ...(nickname ? { nickname } : {}), applied: false, dropped: false });
                s.lastSpin = { id, label: playerLabel(player, nickname), detail: `${manager.name} gets the last ${command.position}. No spin needed.`, startedAt: now - spinDurationMs, options: [playerLabel(player, nickname)], index: 0 };
                break;
            }
            const manager = managers[random(managers.length)];
            const player = players[spin(players.map(p => playerLabel(p, s.nicknames?.[p.id])), `${manager.name} gets a ${command.position}. No refunds.`, assignmentLeadInMs)];
            s.lastSpin!.sliceLabels = players.map(p => s.nicknames?.[p.id] ?? p.name);
            const nickname = s.nicknames?.[player.id];
            s.assignments.push({ id, week: s.week, season: s.season, manager, player, ...(nickname ? { nickname } : {}), applied: false, dropped: false });
            if (players.length === 2 && managers.length === 2) {
                const remainingPlayer = players.find(p => p.id !== player.id)!;
                const remainingManager = managers.find(m => m.id !== manager.id)!;
                const remainingNickname = s.nicknames?.[remainingPlayer.id];
                s.assignments.push({
                    id: crypto.randomUUID(), awardedWithSpinId: id, week: s.week, season: s.season,
                    manager: remainingManager, player: remainingPlayer,
                    ...(remainingNickname ? { nickname: remainingNickname } : {}),
                    applied: false, dropped: false,
                });
                s.lastSpin!.detail += ` ${remainingManager.name} gets ${playerLabel(remainingPlayer, remainingNickname)} by default.`;
            }
            break;
        }
        case "coin": {
            if (s.pending.duration || s.changes.some(c => isCurrent(s, c)))
                throw new Error("This week's chaos round has already started.");
            if (!s.locked.some(p => enabledPositions.includes(p)) || s.locked.some(p => enabledPositions.includes(p) && currentAssignments(s, p).length !== 10))
                throw new Error("Finish all locked player-assignment pools before the league-wide chaos round.");
            s.pending.duration = spin(["Weekly", "Permanent"], "How long must we live with our decisions?") === 0 ? "Weekly" : "Permanent";
            break;
        }
        case "rule": {
            if (!s.pending.duration || s.pending.ruleId)
                throw new Error("Flip the duration coin first, once per round.");
            const rules = s.rules.filter(r => r.duration === s.pending.duration);
            s.pending.ruleId = rules[spin(rules.map(r => r.name), `${s.pending.duration} scoring chaos. Applies to the entire league.`)].id;
            break;
        }
        case "points": {
            const rule = s.rules.find(r => r.id === s.pending.ruleId);
            if (!rule)
                throw new Error("Spin the scoring rule wheel first.");
            const value = pointsWheel[random(pointsWheel.length)];
            const shuffled = [...pointsWheel];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = random(i + 1);
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            const options = shuffled.map(p => `${p > 0 ? "+" : ""}${p} points`);
            const index = shuffled.indexOf(value);
            s.lastSpin = { id, label: options[index], detail: `${rule.name}. An entirely reasonable scoring decision.`, options, index, startedAt: now + 1000 };
            const previous = [...s.changes].reverse().find(c => c.rule.id === rule.id && !c.reverted)?.value ?? rule.baseline;
            s.changes.push({ id, week: s.week, season: s.season, rule, previous, value, applied: false, reverted: false });
            s.pending = { duration: null, ruleId: null };
            break;
        }
        case "assignment-status": {
            const assignment = s.assignments.find(a => a.id === command.id);
            if (!assignment)
                throw new Error("Assignment not found.");
            if (command.field === "dropped" && !assignment.applied)
                throw new Error("Confirm the assignment was applied in Sleeper before marking it dropped.");
            if (command.field === "applied" && assignment.dropped)
                throw new Error("Undo the drop confirmation first.");
            assignment[command.field] = !assignment[command.field];
            break;
        }
        case "change-status": {
            const change = s.changes.find(c => c.id === command.id);
            if (!change)
                throw new Error("Scoring change not found.");
            if (command.field === "reverted" && (change.rule.duration !== "Weekly" || !change.applied))
                throw new Error("Only an applied weekly rule can be marked restored.");
            if (command.field === "applied" && change.reverted)
                throw new Error("Undo the restore confirmation first.");
            change[command.field] = !change[command.field];
            break;
        }
        case "next-week":
            if (s.week === 18)
                throw new Error("Season complete! Export the ledger before starting a new season.");
            if (hasCleanup(s))
                throw new Error("Confirm all player drops, weekly scoring restores, and permanent rule applications first.");
            if (s.pending.duration)
                throw new Error("Finish the current chaos round first.");
            s.week += 1;
            s.players = [];
            s.excluded = [];
            s.locked = [];
            s.lastSpin = null;
            s.source = "Awaiting this week's Sleeper import";
            break;
        case "add-rule":
            if (s.rules.some(r => r.id === command.rule.id || r.name.toLowerCase() === command.rule.name.toLowerCase()))
                throw new Error("That scoring rule already exists.");
            s.rules.push(command.rule);
            break;
        case "import":
            if (s.locked.length || currentAssignments(s).length || s.pending.duration || s.changes.some(c => isCurrent(s, c)))
                throw new Error("This week is in progress. Complete cleanup and advance the week before importing again.");
            if ((s.assignments.length || s.changes.length) && (command.week !== s.week || command.season !== s.season))
                throw new Error("Import into the current week and season to preserve the weekly ledger.");
            s.players = command.players;
            s.season = command.season;
            s.week = command.week;
            s.leagueId = command.leagueId;
            s.managers = command.managers;
            s.source = command.source;
            s.excluded = command.players
                .filter(player => ["out", "ir", "injured reserve"].includes(player.injury?.trim().toLowerCase() ?? ""))
                .map(player => player.id);
            if (command.baselines && !s.changes.length) {
                s.rules = s.rules.map(rule => ({
                    ...rule,
                    baseline: rule.id.startsWith("custom-") ? rule.baseline : command.baselines![rule.id] ?? 0,
                }));
            }
            break;
    }
    return stateSchema.parse(s);
}
