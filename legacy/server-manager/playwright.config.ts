import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:8787", headless: true },
  webServer: {
    command:
      "npx wrangler dev --ip 127.0.0.1 --port 8787 --persist-to .wrangler/e2e",
    url: "http://localhost:8787/health",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
