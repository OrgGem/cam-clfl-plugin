import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3211", headless: true },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    url: "http://127.0.0.1:3211/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
