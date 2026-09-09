import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { transition, type GameState, type Position } from "../../src/lib/game";

function preparedWeek(positions: Position[] = ["QB"], assigned = 0) {
    let game = initialState();
    let now = 1_000_000;
    for (const position of positions) {
        game = transition(game, { type: "lock", position }, () => 0, now += 10_000);
        for (let i = 0; i < assigned; i++)
            game = transition(game, { type: "assign", position }, () => 0, now += 10_000);
    }
    return game;
}

async function openArena(page: Page, state = preparedWeek()) {
    await page.clock.install();
    await page.addInitScript(state => {
        if (!localStorage.getItem("wanduball-practice-v1"))
            localStorage.setItem("wanduball-practice-v1", JSON.stringify(state));
    }, state);
    await page.goto("/");
    await page.getByRole("button", { name: "The chaos room", exact: true }).click();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
}

async function saved(page: Page): Promise<GameState> {
    return page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
}

test("auto-mode completes locked pools and leaves all of round two manual", async ({ page }) => {
    await openArena(page, preparedWeek(["QB", "RB"], 9));
    const toggle = page.getByRole("switch", { name: "Auto-mode" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.locator(".auto-wheel")).toContainText("Next: the QB player wheel in 3");
    await page.clock.fastForward(2900);
    expect((await saved(page)).assignments).toHaveLength(18);
    await page.clock.fastForward(200);
    await expect.poll(async () => (await saved(page)).assignments.length).toBe(19);
    await expect(page.locator(".spin-countdown")).toHaveText("3");
    await page.clock.fastForward(8200);
    await expect(page.locator(".auto-wheel")).toContainText("Next: the RB player wheel in 3");
    expect((await saved(page)).assignments).toHaveLength(19);
    await page.clock.fastForward(3100);
    await expect.poll(async () => (await saved(page)).assignments.length).toBe(20);
    await expect(page.locator(".progress-label")).toContainText("RB assignment progress");
    await page.clock.fastForward(8200);
    await expect(page.locator(".auto-wheel")).toContainText("Round 1 done. Round 2 is yours.");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    const complete = await saved(page);
    await page.clock.fastForward(30_000);
    expect(await saved(page)).toEqual(complete);
    expect(complete.week).toBe(1);
    expect(complete.assignments.every(a => !a.applied && !a.dropped)).toBeTruthy();
    expect(complete.changes).toHaveLength(0);
    expect(complete.pending).toEqual({ duration: null, ruleId: null });
    await page.getByRole("button", { name: "Flip the duration coin" }).click();
    await page.clock.fastForward(30_000);
    expect((await saved(page)).pending.duration).not.toBeNull();
    expect((await saved(page)).pending.ruleId).toBeNull();
    await expect(toggle).toBeDisabled();
    await page.getByRole("button", { name: "Pick the terrible rule" }).click();
    await page.clock.fastForward(30_000);
    expect((await saved(page)).pending.ruleId).not.toBeNull();
    expect((await saved(page)).changes).toHaveLength(0);
    await expect(toggle).toBeDisabled();
});

test("switching off cancels the countdown but lets a committed spin finish", async ({ page }) => {
    await openArena(page);
    const toggle = page.getByRole("switch", { name: "Auto-mode" });
    await toggle.check();
    await page.clock.fastForward(1000);
    await toggle.uncheck();
    await page.clock.fastForward(30_000);
    expect((await saved(page)).assignments).toHaveLength(0);
    await toggle.check();
    await page.clock.fastForward(3100);
    await expect.poll(async () => (await saved(page)).assignments.length).toBe(1);
    await toggle.uncheck();
    await page.clock.fastForward(30_000);
    await expect(page.locator(".recent-assignment")).toHaveCount(1);
    expect((await saved(page)).assignments).toHaveLength(1);
    await expect(toggle).not.toBeChecked();
});

test("leaving the arena, opening a dialog and reloading disarm auto-mode", async ({ page }) => {
    await openArena(page);
    const toggle = page.getByRole("switch", { name: "Auto-mode" });
    await toggle.check();
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    await page.clock.fastForward(10_000);
    expect((await saved(page)).assignments).toHaveLength(0);
    await page.getByRole("button", { name: "The chaos room", exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.getByRole("button", { name: "Invite the degenerates" }).click();
    await page.clock.fastForward(10_000);
    expect((await saved(page)).assignments).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.reload();
    await page.getByRole("button", { name: "The chaos room", exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await page.clock.fastForward(10_000);
    expect((await saved(page)).assignments).toHaveLength(0);
});

test("a manual spin supersedes the queued automatic spin without doubling up", async ({ page }) => {
    await openArena(page);
    await page.getByRole("switch", { name: "Auto-mode" }).check();
    await page.clock.fastForward(2000);
    await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
    await page.clock.fastForward(2000);
    expect((await saved(page)).assignments).toHaveLength(1);
    await page.clock.fastForward(6200);
    await expect(page.locator(".auto-wheel")).toContainText("Next: the QB player wheel in 3");
    await page.clock.fastForward(3100);
    await expect.poll(async () => (await saved(page)).assignments.length).toBe(2);
});

test("failed automatic saves stop the run and never silently retry", async ({ page }) => {
    await openArena(page);
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key: string, value: string) {
            if (key === "wanduball-practice-v1")
                throw new DOMException("Practice storage is full", "QuotaExceededError");
            return original.call(this, key, value);
        };
    });
    const toggle = page.getByRole("switch", { name: "Auto-mode" });
    await toggle.check();
    await page.clock.fastForward(3100);
    await expect(page.locator(".notice[role=alert]")).toContainText("Practice storage is full");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    await expect(toggle).not.toBeChecked();
    await page.clock.fastForward(30_000);
    expect((await saved(page)).assignments).toHaveLength(0);
});

test("a second practice tab receives automatic results without enabling its own auto-mode", async ({ page, context }) => {
    await openArena(page);
    const viewer = await context.newPage();
    await viewer.goto("/");
    await viewer.getByRole("button", { name: "The chaos room", exact: true }).click();
    await page.getByRole("switch", { name: "Auto-mode" }).check();
    await page.clock.fastForward(3100);
    await expect.poll(async () => (await saved(page)).assignments.length).toBe(1);
    const assignment = (await saved(page)).assignments[0];
    await expect(viewer.locator(".spin-heads-up h2")).toHaveText(assignment.manager.name);
    await expect(viewer.getByRole("switch", { name: "Auto-mode" })).not.toBeChecked();
    await page.getByRole("switch", { name: "Auto-mode" }).uncheck();
    await page.clock.fastForward(8200);
    await expect(viewer.locator(".recent-assignment")).toHaveCount(1);
    await expect(viewer.locator(".recent-assignment")).toContainText(assignment.player.name);
});
