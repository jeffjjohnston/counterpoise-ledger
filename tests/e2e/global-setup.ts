import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createHash } from "node:crypto";
import { resolve } from "path";
import { seedBookData } from "./seed-book";
import { e2eDatabaseUrl } from "./database";
import { leaseTestDatabase } from "../helpers/database-safety";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { hashPassword } from "../../lib/auth";
import { MIGRATIONS_FOLDER } from "../../db/create-book";

const E2E_DB_URL = e2eDatabaseUrl();
const E2E_STORAGE_STATE_PATH = resolve(
  "./test-results/e2e-storage-state.json"
);

const SESSION_TOKEN = "e2e-test-session-token-fixed";

function createQuietSql() {
  return postgres(E2E_DB_URL, {
    onnotice: () => {},
  });
}

async function setupDatabase() {
  // Drop and recreate schema for clean slate (including drizzle migration metadata)
  const setupSql = createQuietSql();
  await setupSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await setupSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await setupSql`CREATE SCHEMA public`;
  await setupSql.end();

  // Run migrations
  const migrationSql = createQuietSql();
  await migrate(drizzle(migrationSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await migrationSql.end();

  // Use a fresh connection for seeding
  const sql = createQuietSql();

  // Create user, book, and session
  const passwordHash = await hashPassword("testpassword");
  const now = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const sessionTokenHash = createHash("sha256").update(SESSION_TOKEN).digest("hex");

  await sql`INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'testuser', ${passwordHash}, ${now})`;
  await sql`INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'Test Book', ${now}, ${now})`;
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (${sessionTokenHash}, 1, ${expiresAt}, ${now})`;
  await sql`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true)`;
  await sql`SELECT setval(pg_get_serial_sequence('books', 'id'), 1, true)`;

  return sql;
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

const globalSetup = async () => {
  const release = await leaseTestDatabase(E2E_DB_URL, "counterpoise_e2e");
  try {
    const sql = await setupDatabase();
    try { await seedBookData(sql, 1); } finally { await sql.end(); }
    writeStorageState();
    return release;
  } catch (error) {
    await release();
    throw error;
  }
};

export default globalSetup;
