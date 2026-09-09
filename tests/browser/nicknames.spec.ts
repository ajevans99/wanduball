import { expect, test, type Page } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { nicknameMaxLength, playerLabel, pool, type GameState } from "../../src/lib/game";

const storageKey = "wanduball-practice-v1";
const setup = (page: Page) => page.getByRole("button", { name: "Weekly setup", exact: true }).click();
const arena = (page: Page) => page.getByRole("button", { name: "The chaos room", exact: true }).click();
const nicknameInput = (page: Page, name: string) => page.getByRole("textbox", { name: `Nickname for ${name}`, exact: true });
const saveNickname = (page: Page, name: string) => page.getByRole("button", { name: `Save nickname for ${name}`, exact: true }).click();
const savedState = (page: Page): Promise<GameState> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);

test("the rulebook presents point values in ascending numeric order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Rules of nonsense", exact: true }).click();
  await expect(page.locator(".points-options > span")).toHaveText([
    "-90", "-40", "-8", "-5", "-4", "-2", "-1", "+1", "+2", "+4", "+5", "+8", "+10", "+40", "+90",
  ]);
});

test("inline nicknames save, synchronize to another practice tab, reload, and clear", async ({ page, context }) => {
  await page.goto("/");
  await setup(page);
  const first = initialState().players[0];
  const input = nicknameInput(page, first.name);
  await expect(input).toHaveAttribute("maxlength", String(nicknameMaxLength));
  await input.fill("  The Buffalo  ");
  await saveNickname(page, first.name);
  await expect(input).toHaveValue("The Buffalo");
  const row = page.getByRole("row").filter({ has: input });
  await expect(row.locator(".player-name strong")).toHaveText("The Buffalo");
  await expect(row.locator(".player-real-name")).toHaveText(first.name);
  expect((await savedState(page)).players[0].name).toBe(first.name);
  const second = await context.newPage();
  await second.goto("/");
  await setup(second);
  await expect(nicknameInput(second, first.name)).toHaveValue("The Buffalo");
  await input.fill("Captain Chaos");
  await input.press("Enter");
  await expect(nicknameInput(second, first.name)).toHaveValue("Captain Chaos");
  await page.reload();
  await setup(page);
  await expect(nicknameInput(page, first.name)).toHaveValue("Captain Chaos");
  await page.getByRole("button", { name: `Clear nickname for ${first.name}`, exact: true }).click();
  await expect(nicknameInput(page, first.name)).toHaveValue("");
  await expect(nicknameInput(second, first.name)).toHaveValue("");
  expect((await savedState(page)).nicknames?.[first.id]).toBeUndefined();
  await nicknameInput(page, first.name).fill("Temporary");
  await saveNickname(page, first.name);
  await nicknameInput(page, first.name).fill("   ");
  await saveNickname(page, first.name);
  await expect(nicknameInput(page, first.name)).toHaveValue("");
  await expect(row.locator(".player-name strong")).toHaveText(first.name);
});

test("nicknames survive repeated Sleeper imports and next week's empty pool by stable ID", async ({ page }) => {
  const fixture = initialState();
  fixture.players = fixture.players.map((player, i) => ({ ...player, id: String(4000 + i) }));
  let importCount = 0;
  await page.route("**/api/sleeper?**", route => {
    importCount++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        players: fixture.players.map(player => ({ ...player, team: importCount > 1 ? "NEW" : player.team })),
        managers: fixture.managers, leagueId: "123456789",
        season: 2026, week: Number(new URL(route.request().url()).searchParams.get("week")),
        source: `Sleeper nickname fixture ${importCount}`,
      }),
    });
  });
  await page.goto("/");
  await setup(page);
  await page.getByLabel("Sleeper league ID").fill("123456789");
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("Sleeper nickname fixture 1", { exact: true })).toBeVisible();
  for (const position of ["QB", "RB", "WR", "TE"] as const) {
    await page.getByRole("button", { name: position, exact: true }).click();
    const player = pool(fixture, position)[0];
    await nicknameInput(page, player.name).fill(`${position} superstar`);
    await saveNickname(page, player.name);
  }
  const nicknames = (await savedState(page)).nicknames;
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("Sleeper nickname fixture 2", { exact: true })).toBeVisible();
  expect((await savedState(page)).nicknames).toEqual(nicknames);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Open week 2" }).click();
  await expect.poll(async () => (await savedState(page)).week).toBe(2);
  expect((await savedState(page)).players).toHaveLength(0);
  expect((await savedState(page)).nicknames).toEqual(nicknames);
  await setup(page);
  await page.getByLabel("Week", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.getByText("Sleeper nickname fixture 3", { exact: true })).toBeVisible();
  for (const position of ["QB", "RB", "WR", "TE"] as const) {
    await page.getByRole("button", { name: position, exact: true }).click();
    await expect(nicknameInput(page, pool(fixture, position)[0].name)).toHaveValue(`${position} superstar`);
  }
});

test("locked pools allow naming, spins block it, and result and assignment nicknames are historical snapshots", async ({ page }) => {
  const fixture = initialState();
  fixture.nicknames = Object.fromEntries(pool(fixture, "QB").map(player => [player.id, `QB ${player.name.split(" ")[0]}`]));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, state: fixture });
  await page.clock.install();
  await page.goto("/");
  await setup(page);
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  const first = pool(fixture, "QB")[0];
  await nicknameInput(page, first.name).fill("The Buffalo");
  await saveNickname(page, first.name);
  await arena(page);
  await expect(page.locator(".wheel-label").filter({ hasText: "The Buffalo" })).toHaveText("The Buffalo");
  await expect(page.locator(".wheel-label span").filter({ hasText: "The Buffalo" })).toHaveAttribute("title", `The Buffalo (${first.name})`);
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
  const announced = await savedState(page);
  const assignment = announced.assignments[0];
  const label = playerLabel(assignment.player, assignment.nickname);
  expect(announced.lastSpin?.label).toBe(label);
  await setup(page);
  await expect(nicknameInput(page, assignment.player.name)).toBeDisabled();
  await expect(page.getByRole("button", { name: `Clear nickname for ${assignment.player.name}`, exact: true })).toBeDisabled();
  await page.clock.fastForward(3200);
  await expect(nicknameInput(page, assignment.player.name)).toBeDisabled();
  await page.clock.fastForward(5000);
  await expect(nicknameInput(page, assignment.player.name)).toBeEnabled();
  await nicknameInput(page, assignment.player.name).fill("New nickname");
  await saveNickname(page, assignment.player.name);
  await arena(page);
  await expect(page.locator(".wheel-result h2")).toHaveText(label);
  await expect(page.locator(".recent-assignment .player-name strong")).toHaveText(assignment.nickname!);
  await expect(page.locator(".recent-assignment .player-real-name")).toHaveText(assignment.player.name);
  await page.getByRole("button", { name: "Player assignments", exact: true }).click();
  await expect(page.locator(".player-name strong")).toHaveText(assignment.nickname!);
  await expect(page.locator(".player-real-name")).toHaveText(assignment.player.name);
  await page.getByRole("button", { name: "The evidence locker", exact: true }).click();
  await expect(page.locator(".history-row")).toContainText(label);
  await page.reload();
  await arena(page);
  await expect(page.locator(".wheel-result h2")).toHaveText(label);
  expect((await savedState(page)).assignments).toEqual(announced.assignments);
});

test("nickname inputs do not overflow mobile pages and unavailable shared rooms never offer edits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await setup(page);
  const first = initialState().players[0];
  await nicknameInput(page, first.name).fill("N".repeat(nicknameMaxLength));
  await saveNickname(page, first.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await arena(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const longLabel = page.locator(".wheel-label span").filter({ hasText: "N".repeat(20) });
  await expect(longLabel).toHaveText(`${"N".repeat(20)}…`);
  await expect(longLabel).toHaveAttribute("title", `${"N".repeat(nicknameMaxLength)} (${first.name})`);
  expect(await longLabel.evaluate(label => label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight)).toBeTruthy();
  await page.setViewportSize({ width: 320, height: 780 });
  expect(await longLabel.evaluate(label => label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight)).toBeTruthy();
  await page.goto("/?room=3c1f7a16-8257-41aa-8eaa-c0439f69b2a7");
  await setup(page);
  await expect(page.getByRole("button", { name: "Lock QB top 10" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: /^Nickname for / })).toHaveCount(0);
});
