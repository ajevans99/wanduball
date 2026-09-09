import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { transition } from "../../src/lib/game";

const roomId = "3c1f7a16-8257-41aa-8eaa-c0439f69b2a7";
const accounts = [
    { id: "45d04bc0-ee26-41d4-b5d5-f9b14858c53e", email: "owner@example.com" },
    { id: "d36c212c-32ef-4513-9d77-f741049d287d", email: "second@example.com" },
    { id: "85dced9c-0edf-40c0-a82f-a08985e71f03", email: "third@example.com" },
    { id: "f573ba7e-904a-4d4b-8d01-314028f8a78c", email: "spectator@example.com" },
];

async function fixture(page: Page, initialMembers: number[] = []) {
    const members = new Set(initialMembers.map(index => accounts[index].id));
    const tokens = new Map<string, string>();
    let game = initialState();
    let version = 0;
    let accessUnavailable = false;
    let accessCalls = 0;
    let commandCalls = 0;
    await page.routeWebSocket("**/realtime/v1/**", socket => socket.close());
    await page.route("**/auth/v1/**", async route => {
        if (route.request().url().includes("/logout"))
            return route.fulfill({ status: 204 });
        if (!route.request().url().includes("/token"))
            return route.fulfill({ status: 400, json: { message: "Unexpected fixture auth request" } });
        const { email } = route.request().postDataJSON();
        const account = accounts.find(account => account.email === email);
        if (!account) return route.fulfill({ status: 401, json: { message: "Unknown fixture account" } });
        const expires = Math.floor(Date.now() / 1000) + 3600;
        const token = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: account.id, exp: expires })).toString("base64url")}.fixture`;
        tokens.set(token, account.id);
        return route.fulfill({ json: {
            access_token: token, token_type: "bearer", refresh_token: "fixture-refresh", expires_in: 3600, expires_at: expires,
            user: { ...account, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        } });
    });
    await page.route("**/api/room**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        const userId = tokens.get(request.headers().authorization?.replace(/^Bearer /, "") ?? "");
        const isOwner = userId === accounts[0].id;
        const canEdit = Boolean(userId && (isOwner || members.has(userId)));
        if (url.pathname === "/api/room/commissioners") {
            accessCalls++;
            if (accessUnavailable)
                return route.fulfill({ status: 503, json: { error: "Room permissions are unavailable." } });
            if (!userId)
                return route.fulfill({ status: 401, json: { error: "Sign in first." } });
            if (request.method() === "POST") {
                if (!isOwner)
                    return route.fulfill({ status: 403, json: { error: "Only the creator manages commissioners." } });
                const body = request.postDataJSON();
                if (body.action === "add") {
                    const member = accounts.find(account => account.email === body.email.toLowerCase());
                    if (!member) return route.fulfill({ status: 404, json: { error: "No confirmed account has that email." } });
                    members.add(member.id);
                } else {
                    members.delete(body.userId);
                }
            }
            return route.fulfill({ json: {
                canEdit, isOwner,
                commissioners: isOwner ? accounts.filter(account => members.has(account.id)).map(account => ({ userId: account.id, email: account.email })) : [],
            } });
        }
        if (request.method() === "POST") {
            commandCalls++;
            if (!canEdit)
                return route.fulfill({ status: 403, json: { error: "Only room commissioners can change it." } });
            const body = request.postDataJSON();
            if (body.version !== version)
                return route.fulfill({ status: 409, json: { error: "The room changed. Refresh before trying again." } });
            game = transition(game, body.command, () => 0);
            version++;
        }
        return route.fulfill({ json: { state: game, version } });
    });
    await page.goto(`/?room=${roomId}`);
    return {
        members,
        setUnavailable: (value: boolean) => { accessUnavailable = value; },
        accessCalls: () => accessCalls,
        commandCalls: () => commandCalls,
        game: () => game,
    };
}

async function signIn(page: Page, index: number) {
    await page.getByRole("button", { name: "Room settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email", { exact: true }).fill(accounts[index].email);
    await dialog.getByLabel("Password").fill("fixture-password");
    await dialog.getByRole("button", { name: "Commissioner sign in" }).click();
    await expect(dialog).toContainText(`Signed in as ${accounts[index].email}`);
}

test("creator adds two commissioners by email, sees persisted access, and can remove them", async ({ page }) => {
    const db = await fixture(page);
    await signIn(page, 0);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Room commissioners (1)" })).toBeVisible();
    await dialog.getByLabel("Commissioner email").fill("missing@example.com");
    await dialog.getByRole("button", { name: "Add commissioner", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("No confirmed account");
    for (const index of [1, 2]) {
        await dialog.getByLabel("Commissioner email").fill(accounts[index].email);
        await dialog.getByRole("button", { name: "Add commissioner", exact: true }).click();
        await expect(dialog.getByRole("button", { name: `Remove commissioner ${accounts[index].email}` })).toBeVisible();
    }
    await expect(dialog.getByRole("heading", { name: "Room commissioners (3)" })).toBeVisible();
    await page.reload();
    await page.locator(".profile").click();
    await expect(dialog.getByRole("heading", { name: "Room commissioners (3)" })).toBeVisible();
    page.once("dialog", confirmation => confirmation.accept());
    await dialog.getByRole("button", { name: `Remove commissioner ${accounts[1].email}` }).click();
    await expect(dialog.getByRole("heading", { name: "Room commissioners (2)" })).toBeVisible();
    expect(db.members.has(accounts[1].id)).toBe(false);
    await expect(dialog.getByRole("button", { name: `Remove commissioner ${accounts[0].email}` })).toHaveCount(0);
});

for (const index of [1, 2]) {
    test(`co-commissioner ${index} can edit and spin but cannot manage access`, async ({ page }) => {
        const db = await fixture(page, [1, 2]);
        await signIn(page, index);
        await expect(page.getByRole("dialog")).toContainText("You are a co-commissioner");
        await expect(page.getByLabel("Commissioner email")).toHaveCount(0);
        await expect(page.getByRole("dialog")).not.toContainText(accounts[0].email);
        await expect(page.getByRole("dialog")).not.toContainText(accounts[index === 1 ? 2 : 1].email);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
        await page.getByRole("button", { name: "Lock QB top 10" }).click();
        await page.getByRole("button", { name: "The chaos room", exact: true }).click();
        await expect(page.getByRole("switch", { name: "Auto-mode" })).toBeEnabled();
        await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
        await expect.poll(() => db.game().assignments.length).toBe(1);
        expect(db.commandCalls()).toBe(2);
    });
}

test("spectators stay read-only, including signed-in accounts without room membership", async ({ page }) => {
    const db = await fixture(page, [1, 2]);
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
    expect(db.accessCalls()).toBe(0);
    await signIn(page, 3);
    await expect(page.getByRole("dialog")).toContainText("Ask the room creator");
    await expect(page.getByLabel("Commissioner email")).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toContainText(accounts[1].email);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
    expect(db.commandCalls()).toBe(0);
});

test("revoked access is refreshed without a game change and stops automatic spins", async ({ page }) => {
    await page.clock.install();
    const db = await fixture(page, [1, 2]);
    await signIn(page, 1);
    await expect(page.getByRole("dialog")).toContainText("You are a co-commissioner");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    await page.getByRole("button", { name: "Lock QB top 10" }).click();
    await page.getByRole("button", { name: "The chaos room", exact: true }).click();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const toggle = page.getByRole("switch", { name: "Auto-mode" });
    await toggle.check();
    db.members.delete(accounts[1].id);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await page.clock.fastForward(20000);
    expect(db.game().assignments).toHaveLength(0);
    expect(db.commandCalls()).toBe(1);
});

test("permission outages disable editing and signing out discards owner access", async ({ page }) => {
    const db = await fixture(page);
    await signIn(page, 0);
    await expect(page.getByRole("heading", { name: "Room commissioners (1)" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeEnabled();
    db.setUnavailable(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
    await expect(page.locator(".notice[role=alert]")).toContainText("Room permissions are unavailable");
    db.setUnavailable(false);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeEnabled();
    await page.locator(".profile").click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByLabel("Commissioner email")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
    await signIn(page, 3);
    await expect(page.getByRole("dialog")).toContainText("Ask the room creator");
    await expect(page.getByRole("heading", { name: /Room commissioners/ })).toHaveCount(0);
});

test("open tabs pick up newly granted access by polling and reject a command after removal", async ({ page }) => {
    await page.clock.install();
    const db = await fixture(page);
    await signIn(page, 1);
    await expect(page.getByRole("dialog")).toContainText("Ask the room creator");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    const lock = page.getByRole("button", { name: "Lock QB top 10" });
    await expect(lock).toBeDisabled();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    db.members.add(accounts[1].id);
    await page.clock.fastForward(15000);
    await expect(lock).toBeEnabled();
    db.members.delete(accounts[1].id);
    await lock.click();
    await expect(page.locator(".notice[role=alert]")).toContainText("Only room commissioners");
    await expect(lock).toBeDisabled();
    expect(db.game().locked).toEqual([]);
    expect(db.commandCalls()).toBe(1);
});

test("commissioner management is reachable on mobile without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, [1, 2]);
    await signIn(page, 0);
    await expect(page.getByRole("heading", { name: "Room commissioners (3)" })).toBeVisible();
    await expect(page.getByLabel("Commissioner email")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.getByRole("dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Room settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Room commissioners (3)" })).toBeVisible();
});
