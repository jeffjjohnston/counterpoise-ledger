import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/release.sh");

let root: string;
let repo: string;
let binDir: string;
let denyFile: string;
let releaseBase: string;

/**
 * Runs git quietly, and re-raises a failure with its own stderr attached.
 * Same reasoning as tests/scripts/deploy.test.ts: git reports branch switches
 * and push progress on stderr, and inheriting it buries the vitest summary.
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

function writePackageJson(version: string) {
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        version,
        private: true,
        scripts: {
          // release.sh runs this after the version bump, so the fixture needs a
          // real script to run rather than failing the commit on a missing one.
          "openapi:generate": "mkdir -p openapi && printf '{}\\n' > openapi/openapi.json",
        },
      },
      null,
      2
    )}\n`
  );
}

function version(): string {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
}

function tags(): string[] {
  const listed = git(["tag", "--list"]);
  return listed === "" ? [] : listed.split("\n");
}

function head(): string {
  return git(["rev-parse", "HEAD"]);
}

function branch(): string {
  return git(["branch", "--show-current"]);
}

/** The branches origin holds, so a test can assert what was published. */
function remoteBranches(): string[] {
  const listed = git(["ls-remote", "--heads", "origin"]);
  return listed === ""
    ? []
    : listed.split("\n").map((line) => line.split("refs/heads/")[1]);
}

/** The tags origin holds. Empty is the assertion that matters here. */
function remoteTags(): string[] {
  const listed = git(["ls-remote", "--tags", "origin"]);
  return listed === "" ? [] : listed.split("\n").map((line) => line.split("refs/tags/")[1]);
}

/**
 * Runs the real script with stub `gh` ahead of it on PATH. `npm` is NOT
 * stubbed: `npm version` is the command under test here, and the whole defect
 * turns on the exact commit and tag it leaves behind.
 *
 * npm's own environment is stripped. Vitest runs under `npm test`, which
 * exports npm_config_* into every child, and a stray one would configure the
 * `npm version` this test is measuring.
 */
function release(args: string[] = ["--skip-checks", "patch"]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key.startsWith("NPM_CONFIG_")) delete env[key];
  }

  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * Puts the fixture where the pipeline puts a real release: a checkout DETACHED at
 * the commit being released. release.sh names the branch itself once the bump
 * has told it the version, so a fixture that started on a named release branch
 * would never exercise the naming at all.
 *
 * A detached checkout of the same clone rather than a second worktree: the
 * behaviour under test is what the script does to HEAD, the branch and the
 * remote, and none of it depends on which checkout HEAD sits in.
 */
function detachAtDev() {
  git(["checkout", "--detach", "dev"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cp-release-"));
  binDir = join(root, "bin");
  mkdirSync(binDir);
  denyFile = join(root, "deny-push");

  writeFileSync(
    join(binDir, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "pr create") echo "https://github.com/o/r/pull/1" ;;',
      '  "pr list") echo 1 ;;',
      '  "repo view") echo "o/r" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(join(binDir, "gh"), 0o755);

  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  git(["init", "--bare", "-b", "main", origin], root);

  // Rejects every push while denyFile exists. This reproduces the failure the
  // resume path exists for: the bump is committed and the push does not land,
  // so the tree is CLEAN and the clean-tree guard accepts a retry.
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nif [ -f '${denyFile}' ]; then echo "remote rejected" >&2; exit 1; fi\nexit 0\n`);
  chmodSync(hook, 0o755);

  git(["clone", origin, repo], root);
  git(["config", "user.email", "release-test@example.com"]);
  git(["config", "user.name", "Release Test"]);

  writePackageJson("1.0.0");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);

  git(["checkout", "-b", "dev"]);
  commit("work.txt", "first work");
  git(["push", "origin", "dev"]);
  releaseBase = head();

  detachAtDev();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release.sh runs in a release checkout, never on a shared branch", () => {
  // THE BUMP ON dev IS WHAT USED TO REWRITE IT. release.sh committed the
  // version onto dev, that commit reached main only as a squash, and the
  // deploy then rebased dev onto the replacement history and force-pushed it —
  // changing commit ids under every agent holding a branch off dev. Refusing
  // the shared branches is the first half of removing that.
  it("refuses to run on dev, before it changes anything", () => {
    git(["checkout", "dev"]);

    const run = release();

    expect(run.code, run.output).not.toBe(0);
    expect(run.output).toContain("release checkout");
    // The refusal has to come before the bump, or refusing costs a commit.
    expect(version()).toBe("1.0.0");
    expect(head()).toBe(releaseBase);
  });

  it("refuses to run on main", () => {
    git(["checkout", "main"]);

    const run = release();

    expect(run.code, run.output).not.toBe(0);
    expect(run.output).toContain("release checkout");
  });

  it("names the worktree command in the refusal", () => {
    // The operator reaching this has a correct intention and the old habit.
    // The remedy is the whole message: `git worktree add` appears nowhere in
    // the output they would already be reading.
    git(["checkout", "dev"]);

    expect(release().output).toContain("git worktree add");
  });

  it("runs from a detached checkout, which is how the pipeline starts one", () => {
    // The branch name carries the version, and the version is not knowable
    // until the bump has written package.json — so the checkout cannot be on
    // the release branch before the script runs. A guard that REQUIRED
    // `release/*` would refuse the only state that can legitimately reach it.
    const run = release();

    expect(run.code, run.output).toBe(0);
  });
});

describe("release.sh bumps the version once per release", () => {
  it("bumps, commits and names the release branch", () => {
    const run = release();

    expect(run.code, run.output).toBe(0);
    expect(version()).toBe("1.0.1");
    expect(branch()).toBe("release/v1.0.1");
    // The subject is what release_head_state reads to recognise a resume.
    expect(git(["log", "-1", "--pretty=%s"])).toBe("release: v1.0.1");
    expect(git(["rev-parse", "HEAD^"])).toBe(releaseBase);
  });

  it("pushes the release branch and nothing else", () => {
    release();

    expect(remoteBranches().sort()).toEqual(["dev", "main", "release/v1.0.1"]);
    // dev is not written by a release at all. That is the property the whole
    // change exists for, and it is asserted here rather than inferred from the
    // branch list staying the same length.
    expect(git(["rev-parse", "origin/dev"])).toBe(releaseBase);
  });

  it("creates no tag, locally or on origin", () => {
    // THE TAG IS PUBLISHED ONCE, BY THE DEPLOY, against the commit the merge
    // produced. `npm version` used to make it here, release.sh pushed it, and
    // deploy.sh then force-moved it onto whatever main ended up holding — so
    // a clone that fetched in between held a different commit under the same
    // name. A tag that moves is not a release marker.
    const run = release();

    expect(run.code, run.output).toBe(0);
    expect(tags()).toEqual([]);
    expect(remoteTags()).toEqual([]);
  });

  it("does not publish an unrelated local tag while pushing the release branch", () => {
    git(["tag", "stray-local-tag"]);

    const run = release();

    expect(run.code, run.output).toBe(0);
    expect(tags()).toEqual(["stray-local-tag"]);
    expect(remoteTags()).toEqual([]);
    expect(remoteBranches()).toContain("release/v1.0.1");
  });

  it("resumes at the push instead of bumping again after a failed push", () => {
    // The bump commits, so the tree it leaves is CLEAN and the clean-tree
    // guard at the top of release.sh accepts it. Retrying therefore bumped a
    // second time and numbered a second version for one release.
    writeFileSync(denyFile, "");
    const failed = release();

    expect(failed.code, failed.output).not.toBe(0);
    expect(version()).toBe("1.0.1");
    expect(remoteBranches()).not.toContain("release/v1.0.1");

    rmSync(denyFile);
    const retry = release();

    expect(retry.code, retry.output).toBe(0);
    expect(version(), "the retry bumped a second time").toBe("1.0.1");
    // Resuming has to actually finish the release, not merely decline to bump.
    expect(remoteBranches()).toContain("release/v1.0.1");
    expect(git(["rev-parse", "origin/release/v1.0.1"])).toBe(head());
  });

  it("resumes from the branch the first attempt named", () => {
    // The first attempt gets as far as naming the branch, so the retry starts
    // ON it rather than detached. A guard that only accepted a detached HEAD
    // would refuse every resume.
    writeFileSync(denyFile, "");
    release();
    expect(branch()).toBe("release/v1.0.1");

    rmSync(denyFile);
    const retry = release();

    expect(retry.code, retry.output).toBe(0);
    expect(branch()).toBe("release/v1.0.1");
  });

  it("refuses when the version it would bump to is already tagged", () => {
    // A tag no longer means "a release is half finished" — release.sh makes
    // none. It means that version IS ALREADY RELEASED, so bumping to it again
    // would give two commits one version number.
    writeFileSync(denyFile, "");
    release();
    rmSync(denyFile);
    git(["tag", "-a", "v1.0.1", "-m", "release: v1.0.1"]);

    const run = release();

    expect(run.code, run.output).not.toBe(0);
    expect(run.output).toContain("already exists");
    expect(version()).toBe("1.0.1");
    expect(tags()).toEqual(["v1.0.1"]);
  });

  it("still bumps on a dev that carries a released version", () => {
    // After the back-merge, dev holds main's merge commit and declares the
    // released version, and the tag for it exists. A state reader that looked
    // at the version and the tag alone would call that an unfinished release
    // and never bump again. The commit SUBJECT is what separates the two.
    git(["checkout", "dev"]);
    writePackageJson("1.0.1");
    git(["add", "-A"]);
    git(["commit", "-m", "Merge release/v1.0.1 into dev"]);
    git(["tag", "-a", "v1.0.1", "-m", "release: v1.0.1"]);
    detachAtDev();

    const run = release();

    expect(run.code, run.output).toBe(0);
    expect(version()).toBe("1.0.2");
    expect(branch()).toBe("release/v1.0.2");
    expect(tags()).toEqual(["v1.0.1"]);
  });
});
