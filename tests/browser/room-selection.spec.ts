import { expect, test } from "@playwright/test";

test("explicit practice never requests a shared room, even with a room parameter", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/room**", route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "Unexpected live request" } });
  });
  await page.goto("/?mode=practice&room=69103cd4-0f84-4ce1-b9d1-dfb3096771bc");
  await expect(page.getByText("Practice - not live.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Weekly setup", exact: true }).click();
  expect(requests).toEqual([]);
});

test("invalid explicit room does not silently load practice", async ({ page }) => {
  await page.goto("/?room=invalid");
  await expect(page.getByRole("alert").filter({ hasText: "Invalid room ID" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Weekly setup", exact: true })).toHaveCount(0);
});
