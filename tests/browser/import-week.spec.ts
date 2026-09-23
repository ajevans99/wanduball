import { expect, test } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { transition } from "../../src/lib/game";

test("next-round setup defaults to prior-week stats and preserves assignment history", async ({ page }) => {
  const initial = initialState();
  initial.week = 2;
  const locked = transition(initial, { type: "lock", position: "QB" }, () => 0, 0);
  const assigned = transition(locked, { type: "assign", position: "QB" }, () => 0, 1);
  const next = transition(assigned, { type: "next-week" }, () => 0, 10000);
  await page.addInitScript(state => localStorage.setItem("wanduball-practice-v1", JSON.stringify(state)), next);
  await page.route("**/api/sleeper?**", route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("week")).toBe("3");
    expect(query.get("statsWeek")).toBe("2");
    return route.fulfill({ json: {
      players: initial.players, managers: initial.managers, season: 2026, week: 3,
      leagueId: initial.leagueId, source: "2026 Week 2 actual statistics; setup: 2026 week 3",
    } });
  });
  await page.goto("/?mode=practice");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await expect(page.getByLabel("Assignment week", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Assignment week", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Statistics week", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("2026 Week 2 actual statistics; setup: 2026 week 3", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  expect(saved.week).toBe(3);
  expect(saved.assignments).toEqual(assigned.assignments);
});
