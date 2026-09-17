import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import type { GameState } from "../../src/lib/game";

const roomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
async function fixture(page: Page, mode: "success" | "absent" | "conflict" | "failure") {
  let state: GameState = { ...initialState(), season: 2026, week: 2, leagueId: "1389331555339468800", changes: [], lastSpin: null };
  state.assignments = (["QB", "RB", "WR", "TE"] as const).map((position, i) => ({
    id: String(i + 100), season: 2026, week: 2, applied: true, dropped: false,
    manager: state.managers[0], player: { ...state.players[0], id: String(i + 100), position },
  }));
  state.rosterHistory = [{ id: "source", season: 2026, week: 1, source: "sleeper-commissioner-add",
    transactionId: "history", occurredAt: 1, manager: state.managers[0], player: { id: "999", name: "History", position: "QB" } }];
  let done = 0, steps = 0, version = 80;
  const actions: string[] = [];
  const user = { id: "45d04bc0-ee26-41d4-b5d5-f9b14858c53e", email: "owner@example.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  await page.routeWebSocket("**/realtime/v1/**", socket => socket.close());
  await page.route("**/auth/v1/**", route => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp })).toString("base64url")}.fixture`;
    return route.fulfill({ json: { access_token: token, token_type: "bearer", refresh_token: "fixture", expires_in: 3600, expires_at: exp, user } });
  });
  await page.route("**/api/room**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/room/commissioners") return route.fulfill({ json: { canEdit: true, isOwner: true, commissioners: [] } });
    if (pathname === "/api/room/sleeper") {
      const body = route.request().postDataJSON();
      actions.push(body.action);
      if (body.action === "cleanup-preview") {
        if (mode === "conflict") return route.fulfill({ status: 409, json: { error: "Player moved to another roster. Commissioner review required." } });
        return route.fulfill({ json: { count: 3, week: 2, season: 2026, version } });
      }
      if (body.action === "cleanup-step") {
        steps++;
        expect(body.week).toBe(2);
        expect(body.assignmentId).toBeUndefined();
        if (mode === "failure" && done === 1) return route.fulfill({ status: 409, json: { error: "Drop outcome uncertain. No retry sent." } });
        if (done < 3) return route.fulfill({ json: { completed: false, done: ++done, total: 3 } });
        state = { ...state, week: 3, players: [], assignments: state.assignments.map(a => a.player.position === "TE" ? a : { ...a, dropped: true }) };
        version++;
        return route.fulfill({ json: { completed: true, room: { state, version } } });
      }
      return route.fulfill({ json: { checkedAt: new Date().toISOString(), assignments: Object.fromEntries(state.assignments.map(a =>
        [a.id, { status: mode === "absent" ? "absent" : "applied", canApply: mode === "absent" }])) } });
    }
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { state, version } });
  });
  await page.goto(`/?room=${roomId}`);
  await page.getByRole("button", { name: "Room settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await dialog.getByLabel("Password").fill("fixture-password");
  await dialog.getByRole("button", { name: "Commissioner sign in" }).click();
  await expect(dialog).toContainText("Signed in as owner@example.com");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enter the chaos room" }).click();
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  return { actions, state: () => state, steps: () => steps, resolve: () => { mode = "success"; } };
}
for (const mode of ["success", "absent", "conflict", "failure"] as const) {
  test(`mobile next-week cleanup ${mode}: no TE/history/auto-add and no failure advancement`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page, mode);
    page.on("dialog", async dialog => {
      expect(dialog.message()).toContain("3 assigned QB/RB/WR");
      expect(dialog.message()).toContain("TE and imported history stay");
      await dialog.accept();
    });
    await page.getByRole("button", { name: "Open week 3" }).click();
    if (mode === "success" || mode === "absent") {
      await expect(page.getByText("Outgoing roster cleanup verified. Next week is open.")).toBeVisible();
      expect(f.state().week).toBe(3);
      expect(f.state().assignments[3].dropped).toBe(false);
      expect(f.state().rosterHistory?.[0].player.id).toBe("999");
    } else {
      await expect(page.getByText(/Stopped. Week will not advance/)).toBeVisible();
      expect(f.state().week).toBe(2);
      expect(f.steps()).toBe(mode === "conflict" ? 0 : 2);
      if (mode === "failure") {
        await expect(page.getByRole("button", { name: "Resume cleanup" })).toBeVisible();
        f.resolve();
        await page.getByRole("button", { name: "Resume cleanup" }).click();
        await expect(page.getByText("Outgoing roster cleanup verified. Next week is open.")).toBeVisible();
      }
    }
    expect(f.actions).not.toContain("apply");
  });
}
test("cleanup confirmation can be cancelled; stop pauses after the current player and resumes deliberately", async ({ page }) => {
      const f = await fixture(page, "success");
      page.once("dialog", dialog => dialog.dismiss());
      await page.getByRole("button", { name: "Open week 3" }).click();
      await expect(page.getByRole("button", { name: "Open week 3" })).toBeEnabled();
      expect(f.steps()).toBe(0);
      await page.route("**/api/room/sleeper", async route => {
        if (route.request().postDataJSON().action === "cleanup-step") await new Promise(resolve => setTimeout(resolve, 250));
        await route.fallback();
      });
      page.on("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Open week 3" }).click();
      await expect.poll(() => f.actions.includes("cleanup-preview")).toBe(true);
      await page.getByRole("button", { name: "Stop after current player" }).click();
      await expect(page.getByRole("button", { name: "Resume cleanup" })).toBeEnabled();
      expect(f.steps()).toBeLessThanOrEqual(1);
      expect(f.state().week).toBe(2);
      await page.getByRole("button", { name: "Resume cleanup" }).click();
      await expect(page.getByText("Outgoing roster cleanup verified. Next week is open.")).toBeVisible();
      expect(f.actions).not.toContain("apply");
});
