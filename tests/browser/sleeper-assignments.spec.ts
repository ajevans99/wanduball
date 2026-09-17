import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";

const roomId = "69103cd4-0f84-4ce1-b9d1-dfb3096771bc";
async function fixture(page: Page, secondEligible = false, failApply = false) {
  const state = initialState();
  state.leagueId = "1389331555339468800";
  state.assignments = ["absent", "applied", "dropped", "ineligible"].map((status, index) => ({
    id: `a${index}`, season: state.season, week: state.week,
    manager: state.managers[index],
    player: { id: String(6804 + index), name: `Player ${index}`, position: index === 3 ? "TE" : "QB", team: "BUF", points: 1, injury: null },
    applied: true, dropped: status === "dropped",
  }));
  let statuses: Record<string, { status: string; canApply: boolean }> = {
    a0: { status: "absent", canApply: true }, a1: { status: "applied", canApply: false },
    a2: { status: "dropped", canApply: false }, a3: { status: "ineligible", canApply: false },
  };
  let unavailable = false;
  if (secondEligible) statuses.a1 = { status: "absent", canApply: true };
  let statusCalls = 0;
  const applies: unknown[] = [];
  const user = { id: "45d04bc0-ee26-41d4-b5d5-f9b14858c53e", email: "owner@example.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  await page.routeWebSocket("**/realtime/v1/**", socket => socket.close());
  await page.route("**/auth/v1/**", route => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: expires })).toString("base64url")}.fixture`;
    return route.fulfill({ json: { access_token: token, token_type: "bearer", refresh_token: "fixture", expires_in: 3600, expires_at: expires, user } });
  });
  await page.route("**/api/room**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/room/commissioners")
      return route.fulfill({ json: { canEdit: true, isOwner: true, commissioners: [] } });
    if (path === "/api/room/sleeper") {
      const body = route.request().postDataJSON();
      if (body.action === "status") statusCalls++;
      else {
        applies.push(body);
        if (failApply) return route.fulfill({ status: 503, json: { error: "Could not verify the add. Refresh status." } });
        statuses = { ...statuses, [body.assignmentId]: { status: "applied", canApply: false } };
      }
      return unavailable
        ? route.fulfill({ status: 503, json: { error: "Sleeper status unavailable. Refresh to verify." } })
        : route.fulfill({ json: { assignments: statuses, checkedAt: new Date().toISOString() } });
    }
    return route.fulfill({ json: { state, version: 0 } });
  });
  await page.goto(`/?room=${roomId}`);
  await expect(page.getByRole("button", { name: "Player assignments", exact: true })).toBeVisible();
  return { applies, calls: () => statusCalls, unavailable: () => { unavailable = true; } };
}
async function signIn(page: Page) {
  await page.getByRole("button", { name: "Room settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await dialog.getByLabel("Password").fill("fixture-password");
  await dialog.getByRole("button", { name: "Commissioner sign in" }).click();
  await expect(dialog).toContainText("Signed in as owner@example.com");
  await page.keyboard.press("Escape");
}
test("spectator sees unavailable, not a fabricated stored Applied flag", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.getByText("STATUS UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply this player" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm applied", exact: true })).toHaveCount(0);
  expect(f.calls()).toBe(0);
});
test("live status and direct single-player apply without alerts or disabled/history adds", async ({ page }) => {
  const f = await fixture(page);
  await signIn(page);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.getByText("Applied · verified", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Apply this player" })).toHaveCount(1);
  await expect(page.getByText("Absent · previously dropped")).toBeVisible();
  await expect(page.getByText("Absent · ineligible")).toBeVisible();
  page.on("dialog", dialog => { void dialog.dismiss(); throw new Error("Unexpected apply alert"); });
  await page.getByRole("button", { name: "Apply this player" }).click();
  await expect(page.getByText("Applied · verified", { exact: true })).toHaveCount(2);
  expect(f.applies).toEqual([{ roomId, action: "apply", assignmentId: "a0" }]);
  const calls = f.calls();
  await page.getByRole("button", { name: "The clubhouse", exact: true }).click();
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect.poll(f.calls).toBeGreaterThan(calls);
  f.unavailable();
  await page.getByRole("button", { name: "Refresh Sleeper status" }).click();
  await expect(page.getByText("STATUS UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply this player" })).toHaveCount(0);
});

test("apply to all processes eligible players only", async ({ page }) => {
  const f = await fixture(page, true);
  await signIn(page);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  const button = page.getByRole("button", { name: "Apply to all", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText("2 applied.", { exact: true })).toBeVisible();
  expect(f.applies).toEqual([
    { roomId, action: "apply", assignmentId: "a0" },
    { roomId, action: "apply", assignmentId: "a1" },
  ]);
  await expect(button).toBeDisabled();
});

test("apply to all stops on uncertain outcome and never sends the next player", async ({ page }) => {
  const f = await fixture(page, true, true);
  await signIn(page);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await page.getByRole("button", { name: "Apply to all", exact: true }).click();
  await expect(page.getByText("Stopped after 0 applied.", { exact: true })).toBeVisible();
  expect(f.applies).toEqual([{ roomId, action: "apply", assignmentId: "a0" }]);
  await expect(page.getByRole("button", { name: "Apply to all", exact: true })).toBeDisabled();
});
