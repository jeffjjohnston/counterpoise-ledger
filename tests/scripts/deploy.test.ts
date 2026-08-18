import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/deploy.sh");

let root: string;
let repo: string;
let binDir: string;
let forkPoint: string;

/**
 * Runs git quietly. execFileSync inherits the parent's stderr unless stdio
 * says otherwise, and git reports "Switched to branch", "[new branch]", and
 * clone progress there — 128 lines per run of this file, which buried the
 * vitest summary. Capturing it is only safe if failures stay legible, so a
 * failing command is re-raised with its own stderr attached.
 */
function git(args: string[], cwd = repo): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

function commit(name: string, message: string) {
  writeFileSync(join(repo, name), name);
  git(["add", "-A"]);
  git(["commit", "-m", message]);
}

/** Runs the real script with a stub docker ahead of it on PATH. */
function deploy(options: { dockerFails?: boolean; args?: string[] } = {}) {
  const args = options.args ?? ["--yes"];
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DOCKER_FAIL: options.dockerFails ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function resumeFile() {
  return join(repo, ".git", "DEPLOY_FORK_POINT");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cp-deploy-"));

  binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "docker"),
    '#!/bin/sh\nif [ "$DOCKER_FAIL" = "1" ]; then echo "build failed" >&2; exit 1; fi\nexit 0\n'
  );
  chmodSync(join(binDir, "docker"), 0o755);

  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  // Routed through git() like everything else so no call site can reintroduce
  // inherited stderr. Both run from root, since repo does not exist yet.
  git(["init", "--bare", "-b", "main", origin], root);
  git(["clone", origin, repo], root);
  git(["config", "user.email", "deploy-test@example.com"]);
  git(["config", "user.name", "Deploy Test"]);

  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);

  // dev gains two commits, which main then receives as one squash commit —
  // the state a deploy runs against.
  git(["checkout", "-b", "dev"]);
  commit("a.txt", "A");
  commit("b.txt", "B");
  forkPoint = git(["rev-parse", "HEAD"]);
  git(["push", "origin", "dev"]);

  git(["checkout", "main"]);
  writeFileSync(join(repo, "a.txt"), "a.txt");
  writeFileSync(join(repo, "b.txt"), "b.txt");
  git(["add", "-A"]);
  git(["commit", "-m", "Squash of A and B (#1)"]);
  git(["push", "origin", "main"]);

  // Rewind local main so it sits behind origin/main, which is the real state
  // at deploy time: the squash merge happened on GitHub and this clone has not
  // pulled it. Leaving them equal would trip the "already up to date" prompt on
  // every run and mask what each test is actually checking.
  git(["reset", "--hard", "HEAD~1"]);
  git(["checkout", "dev"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("deploy failure leaves a recoverable state", () => {
  it("exits non-zero when the build fails", () => {
    expect(deploy({ dockerFails: true }).code).not.toBe(0);
  });

  it("restores the branch it started on", () => {
    deploy({ dockerFails: true });

    expect(git(["branch", "--show-current"])).toBe("dev");
  });

  it("records the pending fork point", () => {
    deploy({ dockerFails: true });

    expect(existsSync(resumeFile())).toBe(true);
    expect(readFileSync(resumeFile(), "utf8").trim()).toBe(forkPoint);
  });

  it("names the failed stage and the work left undone", () => {
    const { output } = deploy({ dockerFails: true });

    expect(output).toMatch(/build/i);
    expect(output).toMatch(/not rebased|dev sync|resume/i);
  });
});

describe("resuming after a failure", () => {
  it("rebases dev even when re-run from main", () => {
    // The incident: the failure left the repo on main, and re-running from
    // there skipped the sync entirely because the fork point was only ever
    // derived from being on dev.
    deploy({ dockerFails: true });

    git(["checkout", "dev"]);
    commit("c.txt", "C");
    git(["push", "origin", "dev"]);
    git(["checkout", "main"]);

    const result = deploy();
    expect(result.code).toBe(0);

    const replayed = git(["log", "--oneline", "main..dev"]);
    expect(replayed).toContain("C");
    expect(replayed).not.toContain("A");
    expect(replayed).not.toContain("B");
  });

  it("clears the resume file once the sync completes", () => {
    deploy({ dockerFails: true });
    expect(existsSync(resumeFile())).toBe(true);

    deploy();

    expect(existsSync(resumeFile())).toBe(false);
  });
});

describe("when the fork point cannot be determined", () => {
  it("deploys but exits non-zero rather than skipping the sync quietly", () => {
    git(["checkout", "main"]);

    const { code, output } = deploy();

    expect(code).not.toBe(0);
    expect(output).toMatch(/fork point/i);
  });

  it("still returns to the branch it started on", () => {
    git(["checkout", "-b", "feature/x"]);

    deploy();

    expect(git(["branch", "--show-current"])).toBe("feature/x");
  });
});

describe("when main is already current and nothing confirms the deploy", () => {
  // Reaching this branch non-interactively means --yes was not passed, so
  // nothing chose to abort — exiting 0 would report a deploy that never ran.
  it("exits non-zero rather than reporting success", () => {
    git(["checkout", "main"]);
    git(["merge", "--ff-only", "origin/main"]);
    git(["checkout", "dev"]);

    const { code, output } = deploy({ args: [] });

    expect(code).not.toBe(0);
    expect(output).toMatch(/aborted/i);
  });
});

describe("the normal path", () => {
  it("rebases dev onto main and drops the squashed commits", () => {
    const { code } = deploy();

    expect(code).toBe(0);
    expect(git(["log", "--oneline", "main..dev"])).toBe("");
    expect(existsSync(resumeFile())).toBe(false);
  });

  it("moves the version tag to the deployed commit", () => {
    deploy();

    expect(git(["rev-parse", "v9.9.9"])).toBe(git(["rev-parse", "origin/main"]));
  });
});
