import { defineConfig } from "@playwright/test";
import { resolve } from "path";
import { e2eDatabaseUrl } from "./tests/e2e/database";

const e2eDbUrl = e2eDatabaseUrl();
const e2eStorageStatePath = resolve("./test-results/e2e-storage-state.json");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:3001",
    headless: true,
    storageState: e2eStorageStatePath,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "npx next build --webpack && cp -R .next/static .next/standalone/.next/static && PORT=3001 HOSTNAME=127.0.0.1 node .next/standalone/server.js",
    url: "http://127.0.0.1:3001",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      DATABASE_URL: e2eDbUrl,
      NODE_ENV: "test",
      // The E2E database is seeded with users, so the default rule would close
      // registration and redirect the navigation spec to /login.
      REGISTRATION_ENABLED: "true",
    },
  },
  globalSetup: "./tests/e2e/global-setup.ts",
});
