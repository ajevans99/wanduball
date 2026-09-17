import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["sleeper-assignments.spec.ts", "sleeper-auto.spec.ts", "sleeper-cleanup.spec.ts", "commissioners.spec.ts"],
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:3012", trace: "retain-on-failure" },
  webServer: {
    command: "npm run start -- --port 3012 --hostname localhost",
    url: "http://localhost:3012",
    reuseExistingServer: false,
  },
});
