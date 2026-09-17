import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: { baseURL: "http://localhost:3012", trace: "retain-on-failure" },
  webServer: {
    command: "npm run start -- --port 3012 --hostname localhost",
    url: "http://localhost:3012",
    reuseExistingServer: false,
  },
});
