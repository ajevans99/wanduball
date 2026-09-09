import { expect, test } from "@playwright/test";
import { initialState } from "../../src/lib/seed";
import { pool } from "../../src/lib/game";

test("clubhouse uses the supplied mascot and taglines, with the real league prefilled", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Ten managers. Zero ice cream. One KZ wheel.", { exact: true })).toBeVisible();
    await expect(page.getByText("The pocess is a wheel.", { exact: true })).toBeVisible();
    const mascot = page.locator(".wandu-mascot img");
    await expect(mascot).toBeVisible();
    await expect.poll(() => mascot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mascot).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
    await expect(page.getByLabel("Sleeper league ID")).toHaveValue("1389331555339468800");
});

test("large nickname-only slices preserve full results and reveal the winner only after landing", async ({ page }) => {
    const state = initialState();
    state.locked = ["QB"];
    state.nicknames = Object.fromEntries(pool(state, "QB").map((player, i) => [player.id, i ? `Victim number ${i}` : "The Extremely Unreasonable Football Guy!"]));
    await page.addInitScript(state => localStorage.setItem("wanduball-practice-v1", JSON.stringify(state)), state);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await page.goto("/");
    await page.getByRole("button", { name: "The chaos room", exact: true }).click();
    const labels = page.locator(".wheel-label span");
    await expect(labels.first()).toHaveText("The Extremely Unreas…");
    expect(await labels.first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
    await expect(page.locator(".wheel-hub img")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const straightLabels = await page.addStyleTag({ content: ".wheel-disc, .wheel-label { transform: none !important; }" });
    for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const label of [labels.first(), labels.nth(1)]) {
            const offset = await label.evaluate(element => {
                const range = document.createRange();
                range.selectNodeContents(element);
                const text = range.getBoundingClientRect();
                const box = element.getBoundingClientRect();
                return Math.abs((text.left + text.right - box.left - box.right) / 2);
            });
            expect(offset).toBeLessThan(2);
        }
    }
    await straightLabels.evaluate(element => element.parentNode?.removeChild(element));
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.getByRole("button", { name: "Assign a QB", exact: true }).click();
    await expect(page.locator(".winning-label")).toHaveCount(0);
    await page.clock.fastForward(8200);
    await expect(page.locator(".winning-label")).toHaveCount(1);
    await expect(page.locator(".winning-label span")).toHaveCSS("box-shadow", "none");
    await expect(page.locator(".winning-label span")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const result = await page.evaluate(() => JSON.parse(localStorage.getItem("wanduball-practice-v1")!).assignments[0]);
    await expect(page.locator(".winning-label span")).toHaveAttribute("title", `${result.nickname} (${result.player.name})`);
    await expect(page.locator(".wheel-result h2")).toHaveText(`${result.nickname} (${result.player.name})`);
});
