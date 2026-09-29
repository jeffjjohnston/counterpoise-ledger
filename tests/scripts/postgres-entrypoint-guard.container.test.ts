// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * THE ONE TEST THAT BOOTS A REAL CONTAINER, and the reason is specific.
 *
 * Every other check here runs the guard as a script with a stubbed
 * docker-entrypoint.sh. That proves which branch it takes; it cannot prove
 * that the handover WORKS. A guard that refuses correctly and then fails to
 * reach the stock entrypoint gives a container that initializes nothing — no
 * cluster, no role, no database — and every script-level test stays green
 * while it does. So this one starts postgres:16-alpine for real and asks
 * whether a database came out the other side.
 *
 * It is the slow test in this suite (~10-20s). It earns that by covering the
 * only failure the fast ones structurally cannot see.
 */
const IMAGE = "postgres:16-alpine";
const GUARD = resolve(process.cwd(), "scripts/postgres-entrypoint-guard.sh");
const PUBLISHED = ["counter", "poise"].join("");

const containers: string[] = [];

function startGuarded(password: string): string {
  const name = `cp-guard-test-${randomBytes(6).toString("hex")}`;
  containers.push(name);

  spawnSync("docker", [
    "run", "--detach", "--name", name,
    "--volume", `${GUARD}:/postgres-entrypoint-guard.sh:ro`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--env", "POSTGRES_USER=counterpoise",
    "--env", "POSTGRES_DB=counterpoise",
    "--entrypoint", "/bin/sh",
    IMAGE, "/postgres-entrypoint-guard.sh",
  ], { encoding: "utf8" });

  return name;
}

/** Polls until postgres answers, rather than sleeping a guessed interval. */
function waitForReady(name: string, seconds = 45): boolean {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const ready = spawnSync("docker", [
      "exec", name, "pg_isready", "-U", "counterpoise",
    ], { encoding: "utf8" });
    if (ready.status === 0) return true;

    const alive = spawnSync("docker", [
      "inspect", "-f", "{{.State.Running}}", name,
    ], { encoding: "utf8" });
    if (alive.stdout.trim() !== "true") return false;

    execFileSync("sleep", ["1"]);
  }
  return false;
}

function logs(name: string): string {
  const result = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return result.stdout + result.stderr;
}

function exitCode(name: string): number {
  const result = spawnSync("docker", [
    "inspect", "-f", "{{.State.ExitCode}}", name,
  ], { encoding: "utf8" });
  return Number(result.stdout.trim());
}

afterAll(() => {
  for (const name of containers) {
    spawnSync("docker", ["rm", "--force", "--volumes", name], { encoding: "utf8" });
  }
});

describe("the guard inside a real postgres container", () => {
  it("hands over to the stock entrypoint, and a database is actually created", () => {
    const name = startGuarded("s0me-other-value");

    expect(waitForReady(name), `container never became ready:\n${logs(name)}`).toBe(true);

    // Ready is not enough on its own: it proves a cluster exists, which is the
    // handover this test is here for.
    const query = spawnSync("docker", [
      "exec", name, "psql", "-U", "counterpoise", "-d", "counterpoise",
      "-tAc", "select current_user",
    ], { encoding: "utf8" });

    expect(query.status).toBe(0);
    expect(query.stdout.trim()).toBe("counterpoise");
  }, 120_000);

  /**
   * `exec`, not a child process, and the difference is not cosmetic.
   *
   * Without it the guard's shell stays PID 1 and postgres runs beneath it.
   * The container still answers, so the test above passes either way — this
   * is the guarantee that arm structurally cannot see. What breaks is
   * shutdown: `docker stop` signals PID 1, the shell does not forward it, and
   * postgres is killed on the timeout instead of shutting down cleanly. That
   * is an unclean shutdown on every restart of the deployment.
   */
  it("leaves postgres as PID 1, so a stop signal reaches it", () => {
    const name = startGuarded("s0me-other-value");
    expect(waitForReady(name), `container never became ready:\n${logs(name)}`).toBe(true);

    // BusyBox ps has no -p, so read the table and pick PID 1 out of it.
    const table = spawnSync("docker", [
      "exec", name, "ps", "-o", "pid,comm",
    ], { encoding: "utf8" });
    const pid1 = table.stdout
      .split("\n")
      .map((row) => row.trim().split(/\s+/))
      .find((columns) => columns[0] === "1");

    expect(pid1?.[1], `no PID 1 in:\n${table.stdout}`).toBe("postgres");
  }, 120_000);

  it("refuses a fresh cluster on the published password, and creates nothing", () => {
    const name = startGuarded(PUBLISHED);

    // The container must STOP, not start. Poll for it to exit rather than
    // assume it already has.
    const deadline = Date.now() + 30_000;
    let running = true;
    while (Date.now() < deadline && running) {
      const alive = spawnSync("docker", [
        "inspect", "-f", "{{.State.Running}}", name,
      ], { encoding: "utf8" });
      running = alive.stdout.trim() === "true";
      if (running) execFileSync("sleep", ["1"]);
    }

    expect(running, `container kept running:\n${logs(name)}`).toBe(false);
    expect(exitCode(name)).toBe(1);
    expect(logs(name)).toContain("FATAL");

    // The point of refusing before initdb: no cluster was left behind holding
    // the published password.
    expect(logs(name)).not.toContain("database system is ready to accept connections");
  }, 120_000);
});
