import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { transition, type GameState } from "../../src/lib/game";

const roomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
async function fixture(page: Page, week = 3, paired = false, fail = false) {
  let state: GameState = { ...initialState(), week, leagueId: "1389331555339468800", locked: ["QB"] };
  if (paired) for (let i = 0; i < 8; i++)
    state = transition(state, { type: "assign", position: "QB" }, () => 0, Date.now() - 100000 + i * 10000);
  let version = 0;
  const applies: string[] = [];
  const commands: string[] = [];
  const verified = new Set<string>();
  const user = { id: "45d04bc0-ee26-41d4-b5d5-f9b14858c53e", email: "owner@example.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  await page.routeWebSocket("**/realtime/v1/**", socket => socket.close());
  await page.route("**/auth/v1/**", route => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: expires })).toString("base64url")}.fixture`;
    return route.fulfill({ json: { access_token: token, token_type: "bearer", refresh_token: "fixture", expires_in: 3600, expires_at: expires, user } });
  });
  await page.route("**/api/room**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/room/commissioners") return route.fulfill({ json: { canEdit: true, isOwner: true, commissioners: [] } });
    if (path === "/api/room/sleeper") {
      const body = route.request().postDataJSON();
      if (body.action === "apply") {
        applies.push(body.assignmentId);
        if (fail) return route.fulfill({ status: 409, json: { error: "Unverified outcome; no retries." } });
        verified.add(body.assignmentId);
      }
      return route.fulfill({ json: { checkedAt: new Date().toISOString(), assignments: Object.fromEntries(state.assignments.map(a =>
        [a.id, { status: verified.has(a.id) ? "applied" : "absent", canApply: !verified.has(a.id) }])) } });
    }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      commands.push(body.command.type);
      state = transition(state, body.command, () => 0, await page.evaluate(() => Date.now()));
      version++;
    }
    return route.fulfill({ json: { state, version } });
  });
  await page.goto(`/?room=${roomId}`);
  return { applies, commands, state: () => state, resolve: () => { fail = false; if (applies[0]) verified.add(applies[0]); } };
}
async function operator(page: Page) {
  await page.getByRole("button", { name: "Room settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await dialog.getByLabel("Password").fill("fixture-password");
  await dialog.getByRole("button", { name: "Commissioner sign in" }).click();
  await expect(dialog).toContainText("Signed in as owner@example.com");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enter the chaos room" }).click();
}
test("auto waits for reveal, only adds the ninth/tenth pair, and never backfills on reload", async ({ page }) => {
  const f = await fixture(page, 3, true);
  await operator(page);
  await page.clock.install();
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  await expect(page.getByText("Waiting for the wheel reveal before adding to Sleeper.")).toBeVisible();
  await page.clock.fastForward(7900);
  expect(f.applies).toEqual([]);
  await page.clock.fastForward(200);
  await expect.poll(() => f.applies.length).toBe(2);
  expect(f.applies).toEqual(f.state().assignments.slice(-2).map(a => a.id));
  await page.getByRole("button", { name: "Flip the duration coin" }).click();
  await page.clock.fastForward(10000);
  expect(f.applies.length).toBe(2);
  await page.reload();
  await page.clock.fastForward(20000);
  expect(f.applies.length).toBe(2);
});
test("week 2 and spectator/reconnect never auto-add stored assignments", async ({ page }) => {
  const f = await fixture(page, 2, true);
  await page.clock.install();
  await page.clock.fastForward(20000);
  expect(f.applies).toEqual([]);
  await operator(page);
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  await page.clock.fastForward(10000);
  expect(f.applies).toEqual([]);
});
test("uncertain add pauses the pair and wheel auto-mode until deliberate verification", async ({ page }) => {
  const f = await fixture(page, 3, true, true);
  await operator(page);
  await page.clock.install();
  await page.getByRole("switch", { name: "Auto-mode", exact: true }).check();
  await page.clock.fastForward(3100);
  await expect.poll(() => f.commands.length).toBe(1);
  await page.clock.fastForward(8100);
  await expect(page.getByRole("button", { name: "Resume roster verification" })).toBeVisible();
  expect(f.applies.length).toBe(1);
  await page.clock.fastForward(30000);
  expect(f.applies.length).toBe(1);
  expect(f.commands).toEqual(["assign"]);
  await expect(page.getByRole("button", { name: "Flip the duration coin" })).toBeDisabled();
  f.resolve();
  await page.getByRole("button", { name: "Resume roster verification" }).click();
  await page.clock.fastForward(1);
  await expect.poll(() => f.applies.length).toBe(2);
});
