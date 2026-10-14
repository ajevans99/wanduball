import { expect, test } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { transition } from "../../src/lib/game";

test("next-round setup imports season stats without a statistics-week input and preserves history", async ({ page }) => {
  const initial = initialState();
  initial.week = 2;
  const locked = transition(initial, { type: "lock", position: "QB" }, () => 0, 0);
  const assigned = transition(locked, { type: "assign", position: "QB" }, () => 0, 1);
  const next = transition(assigned, { type: "next-week" }, () => 0, 10000);
  await page.addInitScript(state => localStorage.setItem("wanduball-practice-v1", JSON.stringify(state)), next);
  await page.route("**/api/sleeper?**", route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("week")).toBe("3");
    expect(query.has("statsWeek")).toBe(false);
    expect(query.get("statsSeason")).toBe("2026");
    return route.fulfill({ json: {
      players: initial.players, managers: initial.managers, season: 2026, week: 3,
      leagueId: initial.leagueId, source: "2026 cumulative season statistics; setup: 2026 week 3",
    } });
  });

  await page.goto("/?mode=practice");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await expect(page.getByLabel("Assignment week", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Assignment week", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Statistics week", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("2026 cumulative season statistics; setup: 2026 week 3", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  expect(saved.week).toBe(3);
  expect(saved.assignments).toEqual(assigned.assignments);
});

test("imported bye players are flagged, excluded and replaced in the weekly pool", async ({ page }) => {
  const state = initialState();
  const first = state.players.filter(player => player.position === "QB").sort((a, b) => b.points - a.points)[0];
  const players = state.players.map(player => ({ ...player, bye: player.id === first.id }));
  await page.addInitScript(state => {
    if (!localStorage.getItem("wanduball-practice-v1")) localStorage.setItem("wanduball-practice-v1", JSON.stringify(state));
  }, state);
  await page.route("**/api/sleeper?**", route => route.fulfill({ json: {
    players, managers: state.managers, season: state.season, week: state.week,
    leagueId: state.leagueId, source: "Sleeper bye-week import",
  } }));
  await page.goto("/?mode=practice");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "Pull the players" }).click();
  const row = page.getByRole("row").filter({ hasText: first.name });
  await expect(row.getByText("Bye week", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Bye - excluded", exact: true })).toBeDisabled();
  await expect(row).toHaveClass("excluded-row");
  await expect(page.getByRole("button", { name: "In the pool", exact: true })).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await expect(row.getByText("Bye week", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  expect(saved.excluded).toContain(first.id);
  expect(saved.players.find((player: { id: string }) => player.id === first.id).bye).toBe(true);
});

test("a legacy bye assignment can be corrected without reopening the round and survives reload", async ({ page }) => {
  const state = initialState();
  state.week = 5;
  state.locked = ["QB"];
  const original = { id: "legacy-bye", week: 5, season: state.season,
    player: { ...state.players[0], team: "KC", position: "QB" as const },
    manager: state.managers[0], applied: true, dropped: false };
  state.assignments = [original];
  const replacement = { ...state.players[1], id: "replacement", name: "Replacement Player",
    position: "QB" as const, team: "BUF", injury: null, bye: false, points: 9999 };
  await page.addInitScript(state => {
    if (!localStorage.getItem("wanduball-practice-v1")) localStorage.setItem("wanduball-practice-v1", JSON.stringify(state));
  }, state);
  await page.route("**/api/sleeper?**", route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("week")).toBe("5");
    return route.fulfill({ json: { players: [replacement], byeTeams: ["KC"] } });
  });
  await page.goto("/?mode=practice");
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  const originalRow = page.getByRole("row").filter({ hasText: original.player.name });
  page.once("dialog", dialog => void dialog.dismiss());
  await originalRow.getByRole("button", { name: "Replace bye assignment" }).click();
  await expect(originalRow).toBeVisible();
  page.once("dialog", dialog => {
    expect(dialog.message()).toContain("Confirm you have removed");
    void dialog.accept();
  });
  await originalRow.getByRole("button", { name: "Replace bye assignment" }).click();
  const replacementRow = page.getByRole("row").filter({ hasText: replacement.name });
  await expect(replacementRow).toContainText(original.manager.name);
  await expect(replacementRow).toContainText("Bye replacement");
  await expect(replacementRow.getByRole("button", { name: "Confirm applied", exact: true })).toBeEnabled();
  await expect(originalRow).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!));
  expect(saved.assignments).toHaveLength(2);
  expect(saved.assignments[0].player).toEqual(original.player);
  expect(saved.assignments[0].replacedByAssignmentId).toBe(saved.assignments[1].id);
  expect(saved.locked).toEqual(["QB"]);
  await page.reload();
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(replacementRow).toContainText(original.manager.name);
  await page.getByRole("button", { name: "The evidence locker", exact: true }).click();
  await expect(page.getByText(`Bye: replaced by ${replacement.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(original.player.name, { exact: true })).toBeVisible();
});
