import { expect, test } from "@playwright/test";

const themeKey = "wanduball-theme-v1";
const darkPaper = "rgb(21, 18, 27)";
const lightPaper = "rgb(250, 249, 246)";

test("system appearance follows OS changes while explicit themes persist without changing the league", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Color theme" });
  await expect(picker).toHaveValue("system");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS("background-color", lightPaper);

  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByRole("button", { name: "Lock QB top 10" }).click();
  const game = await page.evaluate(() => localStorage.getItem("wanduball-practice-v1"));
  await picker.selectOption("dark");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#15121b");
  await page.reload();
  await expect(picker).toHaveValue("dark");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  expect(await page.evaluate(() => localStorage.getItem("wanduball-practice-v1"))).toBe(game);

  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("combobox", { name: "Color theme" })).toHaveValue("dark");
  await second.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await expect(picker).toHaveValue("light");
  await expect(page.locator("body")).toHaveCSS("background-color", lightPaper);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS("background-color", lightPaper);
  await picker.selectOption("system");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  expect(errors.filter(error => /hydrat|mismatch|server rendered/i.test(error))).toEqual([]);
});

test("saved dark appearance is applied before application JavaScript loads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(key => localStorage.setItem(key, "dark"), themeKey);
  await page.route("**/_next/**/*.js*", route => route.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  await expect(page.locator(".loading-screen")).toHaveCSS("background-color", "rgb(53, 39, 66)");
});

test("appearance still changes when browser storage is blocked and explains that it cannot save", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("dark");
  await expect(page.locator("body")).toHaveCSS("background-color", darkPaper);
  await expect(page.getByText("Appearance works, but this browser can't save it.")).toBeVisible();
});

test("dark surfaces cover every screen, dialogs and form controls with readable text", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  for (const tab of ["The clubhouse", "Weekly setup", "The chaos room", "Player assignments", "Rules of nonsense", "The evidence locker"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    const issues = await page.evaluate(() => {
      const selectors = [
        "h1", "h2", ".nav-item.active", ".page-heading p", ".panel p", ".hero-copy p",
        ".stat-top>span", ".stat-card p", ".agenda-card p", ".demo-banner", ".table-info",
        ".spin-heads-up p", ".rule-list>div", ".points-options>span", "input", "select",
      ];
      function channels(value: string) {
        return value.match(/[\d.]+/g)!.map(Number);
      }
      function luminance(rgb: number[]) {
        const [r, g, b] = rgb.slice(0, 3).map(channel => {
          const scaled = channel / 255;
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      return [...document.querySelectorAll<HTMLElement>(selectors.join(","))].flatMap(element => {
        if (!element.getClientRects().length) return [];
        let background = element;
        while (getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)" && background.parentElement) {
          background = background.parentElement;
        }
        const style = getComputedStyle(element);
        const fg = luminance(channels(style.color));
        const bg = luminance(channels(getComputedStyle(background).backgroundColor));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        return ratio < (large ? 3 : 4.5) ? [{ selector: element.className || element.tagName, ratio }] : [];
      });
    });
    expect(issues, `${tab} dark text contrast`).toEqual([]);
    await expect(page.locator(".panel").first()).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
  }
  await page.getByRole("button", { name: "Invite the degenerates" }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(34, 29, 42)");
  await expect(page.locator(".setup-note")).not.toHaveCSS("background-color", "rgb(241, 234, 248)");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  await page.getByLabel("Sleeper league ID").fill("12345");
  await page.route("**/api/sleeper?**", route => route.fulfill({
    status: 502, contentType: "application/json", body: JSON.stringify({ error: "Sleeper is unavailable. Please retry." }),
  }));
  await page.getByRole("button", { name: "Pull the players" }).click();
  await expect(page.locator(".notice.error")).toHaveCSS("background-color", "rgb(58, 43, 32)");
});

test("theme control remains usable on small screens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("combobox", { name: "Color theme" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await expect(page.locator("body")).toHaveCSS("background-color", lightPaper);
});
