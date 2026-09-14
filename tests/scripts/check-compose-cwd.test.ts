import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/check-compose-cwd.sh");

/** A throwaway root that holds every directory one test needs. */
let root: string;
/** The main working tree: the one directory Compose may run in. */
let checkout: string;
/** A linked worktree of that checkout: the shape this guard exists for. */
let worktree: string;
/** A directory outside every repository. */
let scratch: string;
/** The copy of the guard the tests run. */
let guard: string;

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Runs the guard in one directory.
 *
 * The copy inside the fixture is used rather than the script in this checkout,
 * because the guard answers a question about the working directory and this
 * suite runs from a worktree of the real repository.
 */
function run(cwd: string) {
  const result = spawnSync(guard, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

beforeEach(() => {
  // Resolved, because the guard reports `pwd -P`. On macOS the temporary
  // directory is reached through a symlink, so an unresolved fixture path and
  // the directory the guard printed are different spellings of one directory.
  root = realpathSync(mkdtempSync(join(tmpdir(), "cp-compose-cwd-")));
  checkout = join(root, "counterpoise");
  scratch = join(root, "scratch");
  mkdirSync(scratch);

  git(["init", "-b", "main", checkout], root);
  git(["config", "user.email", "compose-cwd-test@example.com"], checkout);
  git(["config", "user.name", "Compose Cwd Test"], checkout);

  mkdirSync(join(checkout, "scripts"));
  guard = join(checkout, "scripts", "check-compose-cwd.sh");
  copyFileSync(SCRIPT, guard);
  chmodSync(guard, 0o755);
  writeFileSync(join(checkout, "docker-compose.yml"), "name: counterpoise\n");
  writeFileSync(join(checkout, ".gitignore"), "worktrees/\n");
  mkdirSync(join(checkout, "docs"));
  writeFileSync(join(checkout, "docs", "a.md"), "a\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "base"], checkout);

  worktree = join(checkout, "worktrees", "feature-checkout");
  git(["worktree", "add", "-b", "topic/x", worktree], checkout);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-compose-cwd.sh", () => {
  it("permits the checkout root, and says nothing", () => {
    const { status, stdout, stderr } = run(checkout);

    expect(status, stderr).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  // THE SHAPE THIS GUARDS. `docker compose up` run with a worktree path as
  // its working directory. docker-compose.yml pins the project name, so it
  // addresses the same containers from anywhere, and every relative bind
  // mount resolves against the worktree instead.
  it("refuses a worktree of the same checkout", () => {
    const { status, stderr } = run(worktree);

    expect(status).toBe(1);
    const lines = stderr.split("\n");
    expect(lines).toContain(`  working directory: ${worktree}`);
    expect(lines).toContain(`  checkout root:     ${checkout}`);
  });

  // A DIRECTORY AT A PATH GIT NO LONGER KNOWS AS A WORKTREE. Removal deletes
  // the directory, so this recreates it: the husk is whatever puts a
  // directory back at that path — a stale mount, a build, a hand-made mkdir.
  // It has no .git of its own, so git answers from the checkout above it and
  // the guard still names the checkout root it expected.
  //
  // A shell left in the DELETED directory is a different case, not this one:
  // getcwd() fails on an unlinked directory, so git's discovery aborts before
  // it can walk up to any checkout.
  it("refuses a husk directory at a former worktree path", () => {
    git(["worktree", "remove", "--force", worktree], checkout);
    mkdirSync(worktree, { recursive: true });

    const { status, stderr } = run(worktree);

    expect(status).toBe(1);
    const lines = stderr.split("\n");
    expect(lines).toContain(`  working directory: ${worktree}`);
    expect(lines).toContain(`  checkout root:     ${checkout}`);
  });

  // Compose searches UPWARD for a compose file, so a subdirectory reaches the
  // same production file — and resolves --env-file against the subdirectory.
  it("refuses a subdirectory of the checkout", () => {
    const { status, stderr } = run(join(checkout, "docs"));

    expect(status).toBe(1);
    expect(stderr).toContain(join(checkout, "docs"));
  });

  it("refuses a directory outside every repository, and names it", () => {
    const { status, stderr } = run(scratch);

    expect(status).toBe(1);
    expect(stderr).toContain(scratch);
  });

  // WITHOUT THIS ARM the guard passes for the root of ANY repository, and
  // "this directory is a checkout root" is not the question. The file that
  // pins the project name has to be the one Compose would read here.
  it("refuses a checkout root that holds no compose file", () => {
    const other = join(root, "other-project");
    git(["init", "-b", "main", other], root);

    const { status, stderr } = run(other);

    expect(status).toBe(1);
    expect(stderr).toContain(other);
    expect(stderr).toContain("docker-compose.yml");
  });
});
