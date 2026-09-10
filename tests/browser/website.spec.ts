import { expect, test } from "@playwright/test";
import { initialState } from "../../src/lib/seed";

test("weekly workflow locks pools, assigns without repeats, and persists", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to the nonsense." })).toBeVisible();
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "In the pool", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Excluded", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  await expect(page.getByRole("button", { name: "QB pool locked" })).toBeDisabled();
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  for (let i = 1; i <= 9; i++) {
    await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!).assignments.length)).toBe(i === 9 ? 10 : i);
    await page.clock.fastForward(8200);
  }
  const assignments = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!).assignments);
  expect(new Set(assignments.map((a: { player: { id: string } }) => a.player.id)).size).toBe(10);
  expect(new Set(assignments.map((a: { manager: { id: string } }) => a.manager.id)).size).toBe(10);
  await page.getByRole("button", { name: "Flip the duration coin" }).click();
  await page.clock.fastForward(7200);
  await page.getByRole("button", { name: "Pick the terrible rule" }).click();
  await page.clock.fastForward(7200);
  await page.getByRole("button", { name: "Make the points worse" }).click();
  await page.clock.fastForward(7200);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm applied", exact: true })).toHaveCount(10);
  await page.getByRole("button", { name: "Confirm applied", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Applied", exact: true })).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.getByRole("button", { name: "Applied", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Rules of nonsense", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Actual consequences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm applied", exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("import is explicit and manual rule creation works", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByLabel("Sleeper league ID").fill("12345");
  await page.route("**/api/sleeper?**", route => route.fulfill({
    status: 502, contentType: "application/json", body: JSON.stringify({ error: "Sleeper could not return stats. Please retry." }),
  }));
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText("Sleeper could not return stats");
  await page.getByRole("button", { name: "Rules of nonsense", exact: true }).click();
  await page.getByLabel("Scoring rule name").fill("Test commissioner bonus");
  await page.getByLabel("Current points").fill("-3");
  await page.getByRole("button", { name: "Add to wheel" }).click();
  await expect(page.getByText("Test commissioner bonus", { exact: true })).toBeVisible();
});

test("mobile layout stays within the viewport and dialogs close with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to the nonsense." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Invite the degenerates" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const wheel = await page.locator(".wheel-wrap").boundingBox();
  expect(wheel!.width).toBeGreaterThan(300);
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  await expect(page.locator(".spin-heads-up")).toBeInViewport();
  await expect(page.locator(".spin-countdown")).toBeVisible();
});

test("large wheel announces its manager before spinning and withholds the assignment until reveal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  expect((await page.locator(".wheel-wrap").boundingBox())!.width).toBeGreaterThan(520);
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  const assignment = saved.assignments[0];
  await expect(page.locator(".spin-heads-up h2")).toHaveText(assignment.manager.name);
  await expect(page.locator(".spin-countdown")).toHaveText("3");
  await expect(page.locator(".wheel-wrap")).not.toHaveClass(/is-spinning/);
  await expect(page.getByRole("button", { name: "Chaos in progress..." })).toBeDisabled();
  await expect(page.locator(".recent-assignment")).toHaveCount(0);
  await expect(page.locator(".wheel-result h2")).not.toHaveText(assignment.player.name);
  await page.clock.fastForward(1000);
  await expect(page.locator(".spin-countdown")).toHaveText("2");
  await page.clock.fastForward(1000);
  await expect(page.locator(".spin-countdown")).toHaveText("1");
  await page.clock.fastForward(1100);
  await expect(page.locator(".spin-countdown")).toHaveCount(0);
  await expect(page.locator(".wheel-wrap")).toHaveClass(/is-spinning/);
  await expect(page.locator(".spin-heads-up h2")).toHaveText(assignment.manager.name);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm applied", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "The evidence locker", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  await page.clock.fastForward(5100);
  await expect(page.locator(".wheel-result h2")).toHaveText(assignment.player.name);
  await expect(page.locator(".recent-assignment")).toHaveCount(1);
  await expect(page.locator(".recent-assignment")).toContainText(assignment.manager.name);
});

test("a spectator tab and a reloaded reduced-motion view keep the same announced assignment", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  const spectator = await context.newPage();
  await spectator.emulateMedia({ reducedMotion: "reduce" });
  await spectator.goto("/");
  await spectator.getByRole("button", { name: "The chaos room", exact: true }).click();
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  const pausedAt = new Date(Date.now() + 60_000);
  await page.clock.pauseAt(pausedAt);
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  await expect(spectator.locator(".spin-heads-up h2")).toHaveText(saved.assignments[0].manager.name);
  await expect(spectator.locator(".spin-countdown")).toHaveText("3");
  await page.clock.fastForward(1000);
  await page.reload();
  await page.getByRole("button", { name: "The chaos room", exact: true }).click();
  await expect(page.locator(".spin-heads-up h2")).toHaveText(saved.assignments[0].manager.name);
  await expect(page.locator(".spin-countdown")).toHaveText("2");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!))).toEqual(saved);
  await expect(page.locator(".recent-assignment")).toHaveCount(0);
  await page.clock.fastForward(7200);
  await expect(page.locator(".wheel-result h2")).toHaveText(saved.assignments[0].player.name);
  await expect(spectator.locator(".wheel-result h2")).toHaveText(saved.assignments[0].player.name);
});

test("successful Sleeper import updates pools and league scoring baselines", async ({ page }) => {
  const fixture = initialState();
  await page.route("**/api/sleeper?**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      players: fixture.players, managers: fixture.managers,
      season: 2026, week: 1, leagueId: "123456789",
      source: "Sleeper fixture: 2025 season totals, PPR",
      baselines: { idp_pass_def: 7, rec: 0.5 },
    }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByLabel("Sleeper league ID").fill("123456789");
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("Sleeper fixture: 2025 season totals, PPR")).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!).leagueId)).toBe("123456789");
  const baseline = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!).rules.find((r: { id: string }) => r.id === "idp_pass_def").baseline);
  expect(baseline).toBe(7);
});

test("practice updates reach a second tab and corrupt data is not silently overwritten", async ({ page, context }) => {
  await page.goto("/");
  const second = await context.newPage();
  await second.goto("/");
  await second.getByRole("heading", { name: "Welcome to the nonsense." }).waitFor();
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  await second.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await expect(second.getByRole("button", { name: "QB pool locked" })).toBeDisabled();
  await page.evaluate(() => localStorage.setItem("wanduball-practice-v1", "{broken"));
  await page.reload();
  await expect(page.locator(".notice[role=alert]")).toContainText("Saved practice data could not be read");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem("wanduball-practice-v1"))).toBe("{broken");
});
