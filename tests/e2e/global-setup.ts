import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createHash } from "node:crypto";
import { resolve } from "path";
import type { FullConfig } from "@playwright/test";
import { seedBookData, type ApiPost } from "./seed-book";
import { e2eDatabasePath } from "./database";
import { hashPassword } from "../helpers/password";
import { closeSql, insert, script, setDatabasePath } from "../helpers/sql";

const E2E_DB_PATH = e2eDatabasePath();
const E2E_STORAGE_STATE_PATH = resolve(
  "./test-results/e2e-storage-state.json"
);

const SESSION_TOKEN = "e2e-test-session-token-fixed";

async function setupDatabase() {
  // The web server created and migrated the file when it started. Clear the
  // rows of an earlier run: every table depends on users. Then restart the
  // ID sequences.
  await script("DELETE FROM users; DELETE FROM sqlite_sequence;");

  // Create user, book, and session
  const passwordHash = await hashPassword("testpassword");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const sessionTokenHash = createHash("sha256").update(SESSION_TOKEN).digest("hex");

  await insert("users", { id: 1, username: "testuser", passwordHash });
  await insert("books", { id: 1, userId: 1, name: "Test Book" });
  await insert("sessions", { tokenHash: sessionTokenHash, userId: 1, expiresAt });
}

/** A POST to the E2E server with the session cookie of the E2E user. */
function apiPost(baseUrl: string): ApiPost {
  return async (path, body) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `counterpoise_session=${SESSION_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
}

function writeStorageState() {
  const dir = resolve("./test-results");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storageState = {
    cookies: [
      {
        name: "counterpoise_session",
        value: SESSION_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      },
    ],
    origins: [],
  };

  writeFileSync(E2E_STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}

const globalSetup = async (config: FullConfig) => {
  // Playwright starts the web server before this setup, so the seed can
  // write through the API. The server holds the lock of the file, so a
  // second run on it fails to start its server.
  const baseUrl = config.projects[0]?.use.baseURL;
  if (!baseUrl) throw new Error("The Playwright config must set use.baseURL");
  setDatabasePath(E2E_DB_PATH);
  try {
    await setupDatabase();
    await seedBookData(1, apiPost(baseUrl));
  } finally {
    await closeSql();
  }
  writeStorageState();
};

export default globalSetup;
