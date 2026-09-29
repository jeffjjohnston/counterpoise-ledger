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
  // One server, as in production: the Rust server serves the client build
  // and the API. The build comes first, so the server has pages to serve.
  webServer: [
    {
      command: "npx vite build && cargo run --locked --manifest-path rust-api/Cargo.toml",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      timeout: 180000,
      env: {
        DATABASE_URL: e2eDbUrl,
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Playwright starts web servers before globalSetup migrates the E2E
        // database. Compile SQLx macros from the checked-in query cache.
        SQLX_OFFLINE: "true",
        RUST_BIND: "127.0.0.1:3001",
        COUNTERPOISE_STATIC_DIR: "build",
        // The E2E database is seeded with users, so the default rule would close
        // registration and redirect the navigation spec to /login.
        REGISTRATION_ENABLED: "true",
      },
    },
  ],
  globalSetup: "./tests/e2e/global-setup.ts",
});
