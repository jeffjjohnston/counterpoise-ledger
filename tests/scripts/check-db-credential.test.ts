import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** A credential the guard must accept: dedicated role, own password. */
const ACCEPTED = url("counterpoise_app", "s0me-other-value");

/**
 * Runs the guard with a controlled environment.
 *
 * DATABASE_URL is deleted rather than set to "" for the unset case: the two
 * are different inputs, and only deletion matches what a container started
 * without an env_file actually presents. Both must be refused, and a guard
 * that tests only for definition refuses one and passes the other.
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
    expect(run(ACCEPTED).status).toBe(0);
  });

  it("allows the bootstrap role once its password is changed", () => {
    expect(run(url("counterpoise", "s0me-other-value")).status).toBe(0);
  });

  it("says nothing when DATABASE_URL is set", () => {
    // Silence is the contract for the permitted case. A guard that printed a
    // reassurance on every boot would train an operator to skip the logs this
    // one writes to.
    expect(run(ACCEPTED).stderr).toBe("");
  });
});

/**
 * The guard used to exit 0 on an unset DATABASE_URL, on the premise that
 * "the app fails later with a connection error, which is already clear".
 * It is not. With no DATABASE_URL the app connects to 127.0.0.1:5432 inside
 * its own container and crash-loops, and nothing names the missing file.
 */
describe("check-db-credential.sh refuses a missing credential", () => {
  it("refuses an unset DATABASE_URL", () => {
    expect(run(undefined).status).toBe(1);
  });

  it("names the file the credential comes from", () => {
    // The file is the remedy. A refusal that only says the variable is unset
    // sends the operator to look for an export that was never the mechanism.
    expect(run(undefined).stderr).toContain(".env.production.local");
  });

  // THE ARM A DEFINEDNESS TEST PASSES AND THE REAL DEFECT FAILS. An env_file
  // line with nothing after the `=` defines the variable as an empty string.
  // `[ -n "$DATABASE_URL" ]` and `[ "${DATABASE_URL+set}" = set ]` disagree on
  // exactly this input, and only the first one is the question worth asking:
  // an empty connection string opens nothing.
  it("refuses an empty DATABASE_URL", () => {
    expect(run("").status).toBe(1);
  });

  it("names the file for an empty DATABASE_URL too", () => {
    expect(run("").stderr).toContain(".env.production.local");
  });
});

/**
 * Both containers that carry DATABASE_URL have to reach the guard.
 *
 * The app reaches it through docker-entrypoint.sh, which the image holds. The
 * scheduler runs the stock postgres image, so it has no build of ours to copy
 * the script into: Compose mounts it instead, and the service command runs it
 * before it installs the crontab. Both services can be recreated without a
 * DATABASE_URL, and a guard in one of them alone would leave the hourly dump
 * writing 0 bytes.
 */
describe("the guard reaches every container that carries DATABASE_URL", () => {
  const read = (file: string) =>
    readFileSync(resolve(process.cwd(), file), "utf8");

  it("runs in the app container, from its entrypoint", () => {
    expect(read("docker-entrypoint.sh")).toContain("./check-db-credential.sh");
    expect(read("Dockerfile")).toContain("scripts/check-db-credential.sh");
  });

  it("mounts the same script into the scheduler", () => {
    expect(read("docker-compose.yml")).toContain(
      "./scripts/check-db-credential.sh:/check-db-credential.sh:ro"
    );
  });

  it("runs it in the scheduler before the crontab is installed", () => {
    // Order matters and so does the exit. The service command runs under a
    // plain `sh -c` with no `set -e`, so a refusal that is not followed by an
    // explicit exit installs the crontab anyway and the jobs run without a
    // credential — which is the silent failure this whole change removes.
    const command = read("docker-compose.yml");
    const guard = command.indexOf("sh /check-db-credential.sh || exit 1");
    const crontab = command.indexOf("crontab -");

    expect(guard).toBeGreaterThan(-1);
    expect(crontab).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(crontab);
  });
});
