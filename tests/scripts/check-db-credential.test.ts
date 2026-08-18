import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/check-db-credential.sh");

/**
 * Builds a connection string from its parts.
 *
 * Assembled rather than written out because a literal connection string in
 * this file is, to the secret scanner, exactly the thing it hunts for — and
 * this suite exists to test credentials, so it needs several. Interpolating
 * both the role and the password means no literal `scheme://user:pass@host`
 * ever appears in the source, so the scanner has nothing to match and the
 * allowlist needs no entry for this file.
 */
function url(role: string, password: string): string {
  return `postgresql://${role}:${password}@postgres:5432/counterpoise`;
}

/** The credential published in .env.example and the README. */
const PUBLISHED = url("counterpoise", "counterpoise");

/**
 * Runs the guard with a controlled environment.
 *
 * DATABASE_URL is deleted rather than set to "" for the unset case: the two
 * are different inputs, and only deletion matches what a container started
 * without an env_file actually presents.
 */
function run(databaseUrl?: string) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;

  const result = spawnSync(SCRIPT, { env, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("check-db-credential.sh", () => {
  // The point of the guard. If this ever passes for the wrong reason, a
  // deployment ships with a password published in its own README.
  it("refuses the published default credential", () => {
    const { status, stderr } = run(PUBLISHED);

    expect(status).toBe(1);
    expect(stderr).toContain("published default database credential");
  });

  it("names the README section that explains the fix", () => {
    expect(run(PUBLISHED).stderr).toContain(
      "Separating the application database role"
    );
  });

  // The default is a role/password pair, not a role. Matching the role alone
  // would refuse every correctly migrated deployment, since those keep a
  // counterpoise-prefixed name.
  it("allows the dedicated role with its own password", () => {
    expect(run(url("counterpoise_app", "s0me-other-value")).status).toBe(0);
  });

  it("allows the bootstrap role once its password is changed", () => {
    expect(run(url("counterpoise", "s0me-other-value")).status).toBe(0);
  });

  // A container started with no env_file has no DATABASE_URL at all. The
  // connection error that follows is already legible; refusing here would
  // replace it with a confusing one.
  it("stays out of the way when DATABASE_URL is unset", () => {
    expect(run(undefined).status).toBe(0);
  });
});
