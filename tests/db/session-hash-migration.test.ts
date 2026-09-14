import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeAll, describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db, setupTestDatabase } from "../helpers/db-utils";

describe("session hash migration", () => {
  beforeAll(setupTestDatabase);

  it("migrates legacy sessions without losing identity or expiry", async () => {
    const migration = readFileSync("db/migrations/0011_opposite_argent.sql", "utf8");
    await db.transaction(async (tx) => {
      // A temporary historical table shadows public.sessions on this connection.
      await tx.execute(sql.raw(`CREATE TEMP TABLE sessions (
        id integer PRIMARY KEY, user_id integer NOT NULL,
        expires_at timestamptz NOT NULL, token text NOT NULL,
        CONSTRAINT sessions_token_unique UNIQUE (token)
      ) ON COMMIT DROP`));
      await tx.execute(sql`INSERT INTO sessions VALUES
        (7, 3, '2030-01-02T03:04:05Z', 'legacy-session')`);
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      const rows = await tx.execute(sql`SELECT id, user_id,
        extract(epoch from expires_at)::double precision AS expiry, token_hash FROM sessions`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: 7, user_id: 3, expiry: Date.parse("2030-01-02T03:04:05Z") / 1000,
        token_hash: createHash("sha256").update("legacy-session").digest("hex"),
      });
      // Verify the migrated uniqueness constraint still protects sessions.
      await expect(tx.transaction(async (nested) => {
        await nested.execute(sql`INSERT INTO sessions
          SELECT 8, user_id, expires_at, token_hash FROM sessions WHERE id = 7`);
      })).rejects.toThrow();
    });
  });
});
