import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

function sessionHashMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .find((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8").includes("token_hash"));
  if (!file) throw new Error("No migration references token_hash");
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

describe("session hash migration", () => {
  it("hashes existing tokens in place", () => {
    expect(sessionHashMigration()).toMatch(/encode\(sha256\("?token"?::bytea\), ?'hex'\)/);
  });

  it("renames the column instead of dropping it", () => {
    const sql = sessionHashMigration();
    expect(sql).toMatch(/RENAME COLUMN "?token"? TO "?token_hash"?/i);
    expect(sql).not.toMatch(/DROP COLUMN "?token"?/i);
  });

  it("hashes before renaming", () => {
    const sql = sessionHashMigration();
    expect(sql.indexOf("sha256")).toBeLessThan(sql.search(/RENAME COLUMN/i));
  });
});
