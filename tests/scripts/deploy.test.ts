import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitFixture } from "./git-fixture";

const restoreGit = gitFixture();
const SCRIPT = resolve(process.cwd(), "scripts/deploy.sh");

let root: string;
let repo: string;
let origin: string;
let binDir: string;
/** Where the deploy builds from: a permanent clone outside the source checkout. */
let buildDir: string;
/** Every `docker` invocation the stub saw, with the directory it ran in. */
let dockerLog: string;
/** The commit the release PR merged onto main — what a deploy is given. */
let mergeCommit: string;
/** The tip of the release branch, a parent of the merge commit. */
let releaseHead: string;

/**
 * Runs git quietly. execFileSync inherits the parent's stderr unless stdio
 * says otherwise, and git reports "Switched to branch", "[new branch]", and
 * clone progress there — which buries the vitest summary. Capturing it is only
 * safe if failures stay legible, so a failing command is re-raised with its
 * own stderr attached.
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
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
}

/** Runs the real script with a stub docker ahead of it on PATH. */
function deploy(
  options: {
    dockerFails?: boolean;
    args?: string[];
    /** Replaces the whole environment block rather than adding to it. */
    env?: Record<string, string | undefined>;
    /** Where the deploy is started from. The checkout root, unless a test says otherwise. */
    cwd?: string;
  } = {}
) {
  const args = options.args ?? ["--yes", `--ref=${mergeCommit}`];
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd: options.cwd ?? repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DOCKER_FAIL: options.dockerFails ? "1" : "0",
        DOCKER_LOG: dockerLog,
        COUNTERPOISE_BUILD_DIR: buildDir,
        ...options.env,
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** What the stub docker recorded, or "" when it was never called. */
function dockerCalls(): string {
  return existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
}

/** The directory `docker compose` was invoked from. */
function dockerCwd(): string {
  return dockerCalls()
    .split("\n")
    .filter((line) => line.startsWith("cwd="))
    .map((line) => line.slice("cwd=".length))
    .at(-1) ?? "";
}

/** The absolute backups path `docker compose` interpolated the mounts with. */
function dockerBackupsDir(): string {
  return dockerCalls()
    .split("\n")
    .filter((line) => line.startsWith("backups="))
    .map((line) => line.slice("backups=".length))
    .at(-1) ?? "";
}

function tagType(tag = "v9.9.9") {
  return git(["cat-file", "-t", tag]);
}

function tagMessage(tag = "v9.9.9") {
  return git(["tag", "-l", "--format=%(contents)", tag]).trim();
}

/**
 * What the tag peels to. `^{}` matters: on an ANNOTATED tag a bare rev-parse
 * returns the tag OBJECT, so an unpeeled comparison against a commit answers
 * "different" for a reason that has nothing to do with the deploy. That
 * conflation has already produced one wrong bug report in this repository.
 */
function tagCommit(tag = "v9.9.9", cwd = repo) {
  return git(["rev-parse", `${tag}^{}`], cwd);
}

function remoteTagCommit(tag = "v9.9.9") {
  const lines = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const peeled = lines.split("\n").find((line) => line.endsWith("^{}"));
  return (peeled ?? lines).split("\t")[0];
}

beforeEach(() => {
  // Resolved, because the stub docker reports `pwd`. On macOS the temporary
  // directory is reached through a symlink, so an unresolved fixture path and
  // the directory the script actually ran in are different strings for the
  // same directory.
  root = realpathSync(mkdtempSync(join(tmpdir(), "cp-deploy-")));

  binDir = join(root, "bin");
  mkdirSync(binDir);
  // Records the directory it ran in and the backups path Compose would
  // interpolate the bind mounts with. Both are the subject of this suite: the
  // build context is whatever directory `docker compose` runs from, and a
  // bind source Docker cannot find is CREATED EMPTY rather than refused.
  dockerLog = join(root, "docker.log");
  writeFileSync(
    join(binDir, "docker"),
    "#!/bin/sh\n" +
      '{ echo "cwd=$(pwd)"; echo "backups=${COUNTERPOISE_BACKUPS_DIR-}"; echo "args=$*"; } >>"$DOCKER_LOG"\n' +
      'if [ "$DOCKER_FAIL" = "1" ] && [ "$6" = "up" ]; then echo "build failed" >&2; exit 1; fi\n' +
      // The database volume: DOCKER_NO_VOLUME makes it absent, and
      // DOCKER_RUN_STATUS is the exit of the `test -e counterpoise.db` in it.
      'if [ "$1" = "volume" ] && [ "${DOCKER_NO_VOLUME-}" = "1" ]; then exit 1; fi\n' +
      'if [ "$1" = "run" ] && [ -n "${DOCKER_RUN_STATUS-}" ]; then exit "$DOCKER_RUN_STATUS"; fi\n' +
      "exit 0\n"
  );
  chmodSync(join(binDir, "docker"), 0o755);

  origin = join(root, "origin.git");
  repo = join(root, "repo");
  // Outside the source checkout, which is the whole point of it. Permanent in
  // production; here it is simply a path the deploy is free to create.
  buildDir = join(root, "production");
  restoreGit(root, () => {
    // Routed through git() like everything else so no call site can reintroduce
    // inherited stderr. Both run from root, since repo does not exist yet.
    git(["init", "--bare", "-b", "main", origin], root);
    git(["clone", origin, repo], root);
    git(["config", "user.email", "deploy-test@example.com"]);
    git(["config", "user.name", "Deploy Test"]);

    writePackageJson("9.9.8");
    // The deploy refuses a working directory that is not the checkout root, and
    // the compose file is half of how it recognises one. See
    // scripts/check-compose-cwd.sh.
    writeFileSync(join(repo, "docker-compose.yml"), "name: counterpoise\n");
    // The real repository ignores both of these, which is exactly why the stale
    // nested checkout that broke a release survived every `git status
    // --porcelain` gate: --porcelain does not report ignored paths.
    writeFileSync(join(repo, ".gitignore"), "backups/\n.env.production.local\n.env.deploy.local\nworktrees/\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
    git(["push", "origin", "main"]);

    git(["checkout", "-b", "dev"]);
    commit("a.txt", "A");
    commit("b.txt", "B");
    git(["push", "origin", "dev"]);

    // The release branch: cut from dev and bumped there, exactly as the pipeline
    // does it. The bump is what makes the deployed commit declare 9.9.9.
    git(["checkout", "-b", "release/v9.9.9"]);
    writePackageJson("9.9.9");
    git(["add", "-A"]);
    git(["commit", "-m", "release: v9.9.9"]);
    releaseHead = git(["rev-parse", "HEAD"]);
    git(["push", "origin", "release/v9.9.9"]);

    // AN AGENT LANDS ON dev WHILE THE RELEASE IS IN FLIGHT. This is the case the
    // whole change exists for, and it is in the baseline fixture rather than in
    // one test: without it dev is a strict ancestor of the merge commit, and a
    // deploy that rebased dev away would leave every assertion here true.
    git(["checkout", "dev"]);
    commit("c.txt", "C");
    git(["push", "origin", "dev"]);

    // A MERGE COMMIT, not a squash. The release commits stay in the ancestry of
    // main, which is the whole reason nothing downstream has to rebase dev.
    git(["checkout", "main"]);
    git(["merge", "--no-ff", "-m", "Merge release/v9.9.9 into main", "release/v9.9.9"]);
    mergeCommit = git(["rev-parse", "HEAD"]);
    git(["push", "origin", "main"]);

    // Back on dev, which is where an operator runs this from and where it has to
    // be left. Local main is rewound so it sits behind origin/main, the real
    // state at deploy time: the merge happened on GitHub and this clone has not
    // pulled it.
    git(["checkout", "main"]);
    git(["reset", "--hard", "HEAD~1"]);
    git(["checkout", "dev"]);

    // The two untracked things the production checkout owns. Both are gitignored
    // in the real repository, so neither is in any commit and neither can arrive
    // in the build directory by way of a checkout.
    mkdirSync(join(repo, "backups"));
    writeFileSync(join(repo, "backups", "counterpoise-20260907-150000.dump"), "dump");
    writeFileSync(join(repo, ".env.production.local"), "TZ=UTC\n");
  });
  git(["clone", origin, buildDir], root);
  git(["reset", "--hard", "HEAD~1"], buildDir);
  mkdirSync(join(buildDir, "backups"));
  writeFileSync(join(buildDir, "backups", "saved.dump"), "production backup");
  writeFileSync(join(buildDir, ".env.production.local"), "TZ=Europe/London\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("deploy.sh deploys one named commit", () => {
  it("refuses without --ref rather than guessing what to deploy", () => {
    const { code, output } = deploy({ args: ["--yes"] });

    expect(code).not.toBe(0);
    expect(output).toContain("--ref is required");
  });

  it("builds from the commit it was given", () => {
    const { code, output } = deploy();

    expect(code, output).toBe(0);
    expect(output).toContain(mergeCommit.slice(0, 7));
  });

  it("returns to the branch it started on", () => {
    deploy();

    expect(git(["branch", "--show-current"])).toBe("dev");
  });

  it("refuses a commit that is not on origin/main", () => {
    // Only a commit a release PR landed may be deployed. Anything else would
    // put code into production that nothing merged, and publish this version
    // tag against it. dev's tip is that commit here: it gained work after the
    // release branch was cut, so main does not hold it.
    const unmerged = git(["rev-parse", "dev"]);

    const { code, output } = deploy({ args: ["--yes", `--ref=${unmerged}`] });

    expect(code).not.toBe(0);
    expect(output).toContain("is not on origin/main");
    expect(git(["tag", "--list"])).toBe("");
  });

  it("refuses a ref that does not resolve", () => {
    const { code, output } = deploy({ args: ["--yes", "--ref=nope"] });

    expect(code).not.toBe(0);
    expect(output).toContain("does not resolve to a commit");
  });

  it("accepts --ref as two words as well as one", () => {
    const { code, output } = deploy({ args: ["--yes", "--ref", mergeCommit] });

    expect(code, output).toBe(0);
  });

  // THE FAILURE THIS GUARDS AGAINST ENTERS THROUGH A WORKTREE PATH. Every preflight
  // question below asks about "this checkout", and `git rev-parse
  // --show-toplevel` answers with the worktree — so the source root, the
  // backups directory and the environment file would all resolve there, while
  // the pinned project name still addresses the production containers.
  // scripts/check-compose-cwd.sh owns the refusal; this proves the deploy runs
  // it, and runs it before anything is published.
  it("refuses to deploy from a worktree of the checkout", () => {
    const worktree = join(repo, "worktrees", "feature-checkout");
    git(["worktree", "add", "-b", "topic/x", worktree]);

    const { code, output } = deploy({ cwd: worktree });

    expect(code).not.toBe(0);
    expect(output).toContain("Compose must run in the checkout root");
    expect(output).toContain(`working directory: ${worktree}`);
    // NAMED AS THE CHECKOUT ROOT, not merely present. The worktree path has the
    // repository path as a prefix, so a bare toContain(repo) is satisfied by the
    // line above it and would pass for any refusal at all.
    expect(output).toContain(`checkout root:     ${realpathSync(repo)}`);
    // AND IT REFUSED FIRST. Without the guard this deploy still stops, but on
    // the backups directory — a message that names the same worktree path for
    // an unrelated reason, three checks later. This is what tells the two apart.
    expect(output).not.toContain("the backups directory");
    expect(git(["tag", "--list"])).toBe("");
    expect(dockerCalls()).toBe("");
  });
});

describe("deploy.sh leaves dev alone", () => {
  // THE POINT OF THE WHOLE CHANGE. The old deploy ran `git rebase --onto main
  // <fork-point> dev` and force-pushed the result, rewriting commit ids under
  // every agent holding a branch off dev. Reproduced on a throwaway clone
  // 2026-08-31: four release commits discarded, exit 0.
  it("does not move dev, locally or on origin", () => {
    const before = git(["rev-parse", "dev"]);
    const beforeRemote = git(["rev-parse", "origin/dev"]);

    const { code, output } = deploy();

    expect(code, output).toBe(0);
    expect(git(["rev-parse", "dev"])).toBe(before);
    expect(git(["rev-parse", "origin/dev"])).toBe(beforeRemote);
  });

  it("leaves every dev commit reachable under its original id", () => {
    // The identities, not just the branch tip. A rebase would have kept dev
    // pointing somewhere plausible while replacing every commit under it.
    const ids = git(["rev-list", "origin/main..dev"]).split("\n").filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);

    deploy();

    for (const id of ids) {
      expect(git(["cat-file", "-t", id])).toBe("commit");
      expect(git(["merge-base", "--is-ancestor", id, "dev"])).toBe("");
    }
  });

  it("refuses when a deploy from the previous flow left a sync owed", () => {
    // .git/DEPLOY_FORK_POINT means a dev rebase onto main is still pending
    // from the old flow. This script cannot perform it, and deploying over an
    // unreconciled dev silently would leave the file to be found later.
    const legacy = join(repo, ".git", "DEPLOY_FORK_POINT");
    writeFileSync(legacy, `${releaseHead}\n`);

    const { code, output } = deploy();

    expect(code).not.toBe(0);
    expect(output).toContain("DEPLOY_FORK_POINT");
    expect(git(["tag", "--list"])).toBe("");
  });
});

describe("the version tag is published once and never moved", () => {
  it("creates it, annotated, at the deployed commit", () => {
    deploy();

    expect(tagType()).toBe("tag");
    expect(tagCommit()).toBe(mergeCommit);
    expect(tagMessage()).toBe("release: v9.9.9");
  });

  it("pushes it to origin", () => {
    deploy();

    expect(remoteTagCommit()).toBe(mergeCommit);
  });

  it("pushes it without --force, so a fetched clone is never contradicted", () => {
    // The old deploy force-pushed a tag release.sh had already published, so
    // anyone who fetched in between held a different commit under this name
    // and a plain `git fetch` would not correct them. Nothing moves now, so a
    // plain fetch is the whole recovery.
    deploy();

    const clone = join(root, "fresh");
    git(["clone", origin, clone], root);
    expect(tagCommit("v9.9.9", clone)).toBe(mergeCommit);
  });

  it("leaves it alone on a second deploy of the same commit", () => {
    deploy();
    const first = tagCommit();

    const again = deploy();

    expect(again.code, again.output).toBe(0);
    expect(tagCommit()).toBe(first);
    expect(tagType()).toBe("tag");
    expect(tagMessage()).toBe("release: v9.9.9");
  });

  it("refuses when the tag already names a different commit", () => {
    // Either this version released twice or the wrong --ref. Both are
    // refusals: a force-push here would silently re-point a tag that clones
    // and release notes already reference.
    git(["tag", "-a", "v9.9.9", releaseHead, "-m", "release: v9.9.9"]);

    const { code, output } = deploy();

    expect(code).not.toBe(0);
    expect(output).toContain("already points at");
    expect(tagCommit()).toBe(releaseHead);
  });

  it("leaves the checkout where it found it when it refuses the tag", () => {
    // THE REFUSAL MUST COST NOTHING. An explicit `exit` does NOT fire the ERR
    // trap, so a refusal raised AFTER the checkout never restored the branch:
    // measured on a disposable repository, the run correctly refused and left
    // `git branch --show-current` EMPTY with HEAD at the deploy target. The
    // deploy uses the shared checkout, so that strands the repository off dev
    // and every dev-only phase downstream then refuses for a second reason.
    //
    // Fixed by validating the tag before anything moves, not by adding another
    // restore call — so this asserts HEAD never moved at all, which a
    // restore-after-the-fact could not produce.
    git(["tag", "-a", "v9.9.9", releaseHead, "-m", "release: v9.9.9"]);
    const before = git(["rev-parse", "HEAD"]);

    const { code } = deploy();

    expect(code).not.toBe(0);
    expect(git(["branch", "--show-current"]), "the refusal left a detached HEAD").toBe("dev");
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("leaves the checkout where it found it when it declines a re-deploy", () => {
    // The same property on the other early exit. Declining is a decision, not
    // a failure, so it must not be visible in the repository afterwards.
    deploy();
    const before = git(["rev-parse", "HEAD"]);

    const { code } = deploy({ args: [`--ref=${mergeCommit}`] });

    expect(code).not.toBe(0);
    expect(git(["branch", "--show-current"])).toBe("dev");
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("refuses when origin holds the tag at a different commit", () => {
    // Read from origin and not only from the local ref: a clone that never
    // fetched this tag would otherwise create a second object under a name
    // origin already publishes.
    git(["tag", "-a", "v9.9.9", releaseHead, "-m", "release: v9.9.9"]);
    git(["push", "origin", "refs/tags/v9.9.9"]);
    git(["tag", "-d", "v9.9.9"]);

    const { code, output } = deploy();

    expect(code).not.toBe(0);
    expect(output).toContain("already points at");
  });

  it("recovers a tag that was made locally but never pushed", () => {
    // The resume: the tag was created and the push then failed. It names the
    // right commit, so finishing means pushing it — not refusing it as a
    // clash with itself.
    git(["tag", "-a", "v9.9.9", mergeCommit, "-m", "release: v9.9.9"]);

    const { code, output } = deploy();

    expect(code, output).toBe(0);
    expect(remoteTagCommit()).toBe(mergeCommit);
  });

  it("tags before it builds, so a failed build does not lose the marker", () => {
    // The tag names the commit main holds, which is a fact the build cannot
    // change. Publishing it first is also what makes a retry idempotent.
    const { code } = deploy({ dockerFails: true });

    expect(code).not.toBe(0);
    expect(tagCommit()).toBe(mergeCommit);
  });
});

describe("deploy failure leaves a recoverable state", () => {
  it("exits non-zero when the build fails", () => {
    expect(deploy({ dockerFails: true }).code).not.toBe(0);
  });

  it("leaves the source checkout exactly where it found it", () => {
    // A failed build is where the old flow stranded the shared checkout: it had
    // already been detached at the deploy target, and every dev-only phase
    // downstream then refused for a second reason. Nothing checks anything out
    // there any more, so HEAD is asserted as well as the branch name.
    const head = git(["rev-parse", "HEAD"]);

    deploy({ dockerFails: true });

    expect(git(["branch", "--show-current"])).toBe("dev");
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });

  it("names the failed stage", () => {
    const { output } = deploy({ dockerFails: true });

    expect(output).toMatch(/build/i);
    expect(output).toContain("Deploy failed during");
  });

  it("keeps no resume file, because every stage is idempotent", () => {
    // The fork point was the only thing a resume file ever carried, and there
    // is no rebase left to feed one. Re-running the same command finishes the
    // job.
    deploy({ dockerFails: true });

    expect(existsSync(join(repo, ".git", "DEPLOY_FORK_POINT"))).toBe(false);
  });

  it("succeeds on a re-run once the build works", () => {
    deploy({ dockerFails: true });

    const retry = deploy();

    expect(retry.code, retry.output).toBe(0);
    expect(tagCommit()).toBe(mergeCommit);
  });
});

describe("repeating a deploy is confirmed, not assumed", () => {
  it("exits non-zero rather than reporting a deploy nothing confirmed", () => {
    // Reaching this branch non-interactively means --yes was not passed, so
    // nothing chose to abort — exiting 0 would report a deploy that never ran.
    deploy();

    const { code, output } = deploy({ args: [`--ref=${mergeCommit}`] });

    expect(code).not.toBe(0);
    expect(output).toMatch(/aborted/i);
  });

  it("does not prompt on the first deploy of a commit", () => {
    const { code, output } = deploy({ args: [`--ref=${mergeCommit}`] });

    expect(code, output).toBe(0);
  });

  it("returns to the branch it started on when it aborts", () => {
    deploy();

    deploy({ args: [`--ref=${mergeCommit}`] });

    expect(git(["branch", "--show-current"])).toBe("dev");
  });
});

describe("deploy.sh reads an annotated tag correctly", () => {
  it("does not mistake the tag object for the commit it names", () => {
    // `git rev-parse v1.2.3` on an annotated tag returns the TAG OBJECT. A
    // comparison against a commit therefore reports "different" for every
    // annotated tag, which would turn every clean re-run into a refusal.
    deploy();

    expect(git(["rev-parse", "v9.9.9"])).not.toBe(mergeCommit);
    expect(tagCommit()).toBe(mergeCommit);

    const again = deploy();
    expect(again.code, again.output).toBe(0);
  });

  it("does not read a lightweight tag's commit message as the tag message", () => {
    // `%(contents)` on a LIGHTWEIGHT tag reports the COMMIT message. A tag some
    // older deploy flattened would otherwise engrave the merge subject as this
    // release's tag message — but a lightweight tag at the right commit is
    // accepted, so the annotated object has to be made from the version, not
    // read back off the ref.
    git(["tag", "v9.9.9", mergeCommit]);

    const { code, output } = deploy();

    expect(code, output).toBe(0);
    expect(tagMessage()).toBe("release: v9.9.9");
    expect(tagMessage()).not.toContain("Merge release");
  });
});


describe("production checkout ownership", () => {
  it("uses production credentials without copying from dev and fast-forwards main to the exact SHA", () => {
    const { code, output } = deploy();
    expect(code, output).toBe(0);
    expect(readFileSync(join(buildDir, ".env.production.local"), "utf8")).toBe("TZ=Europe/London\n");
    expect(git(["branch", "--show-current"], buildDir)).toBe("main");
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(mergeCommit);
    expect(dockerCwd()).toBe(buildDir);
    expect(dockerBackupsDir()).toBe(join(buildDir, "backups"));
    expect(readFileSync(join(buildDir, "backups", "saved.dump"), "utf8")).toBe("production backup");
  });

  it("does not require a production environment file in dev", () => {
    rmSync(join(repo, ".env.production.local"));
    const result = deploy();
    expect(result.code, result.output).toBe(0);
  });

  it("refuses a missing production environment even if dev has one", () => {
    rmSync(join(buildDir, ".env.production.local"));
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("no .env.production.local in production");
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(before);
    expect(git(["tag", "--list"])).toBe("");
    expect(dockerCalls()).toBe("");
  });

  it.each(["dev", "detached"])("refuses a production checkout on %s", (branch) => {
    git(branch === "detached" ? ["checkout", "--detach"] : ["checkout", "dev"], buildDir);
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("production checkout must be on main");
    expect(dockerCalls()).toBe("");
  });

  it.each(["tracked", "untracked", "ignored"])("preserves and refuses %s production changes", (kind) => {
    const path = kind === "tracked" ? "package.json" : kind === "ignored" ? "worktrees/junk.txt" : "junk.txt";
    if (kind === "ignored") mkdirSync(join(buildDir, "worktrees"));
    writeFileSync(join(buildDir, path), "preserve me");
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("unexpected files or changes");
    expect(readFileSync(join(buildDir, path), "utf8")).toBe("preserve me");
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(before);
    expect(dockerCalls()).toBe("");
    expect(git(["tag", "--list"])).toBe("");
  });

  it("deploys over Finder .DS_Store files and leaves them in place", () => {
    // Finder writes these whenever a folder is opened. They carry no project
    // data, and deleting them by hand was the only way past this check.
    mkdirSync(join(buildDir, "app"), { recursive: true });
    writeFileSync(join(buildDir, ".DS_Store"), "finder");
    writeFileSync(join(buildDir, "app", ".DS_Store"), "finder");
    const result = deploy();
    expect(result.code, result.output).toBe(0);
    expect(readFileSync(join(buildDir, ".DS_Store"), "utf8")).toBe("finder");
    expect(readFileSync(join(buildDir, "app", ".DS_Store"), "utf8")).toBe("finder");
  });

  it("still refuses another stray file next to a .DS_Store", () => {
    writeFileSync(join(buildDir, ".DS_Store"), "finder");
    writeFileSync(join(buildDir, "junk.txt"), "preserve me");
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("junk.txt");
    expect(result.output).not.toContain(".DS_Store");
    expect(dockerCalls()).toBe("");
  });

  it("refuses to rewind production main", () => {
    git(["checkout", "main"]);
    git(["merge", "--ff-only", "origin/main"]);
    commit("newer.txt", "newer release");
    git(["push", "origin", "main"]);
    git(["pull", "--ff-only"], buildDir);
    git(["checkout", "dev"]);
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("cannot fast-forward");
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(before);
    expect(dockerCalls()).toBe("");
    expect(git(["tag", "--list"])).toBe("");
  });

  it("keeps an ignored nested dev checkout outside the production build", () => {
    mkdirSync(join(repo, "worktrees", "stale"), { recursive: true });
    writeFileSync(join(repo, "worktrees", "stale", "bad.ts"), "broken");
    const result = deploy();
    expect(result.code, result.output).toBe(0);
    expect(existsSync(join(dockerCwd(), "worktrees"))).toBe(false);
  });

  it("defaults to ~/counterpoise-production", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(buildDir, join(home, "counterpoise-production"));
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: undefined, HOME: home } });
    expect(result.code, result.output).toBe(0);
    expect(dockerCwd()).toBe(buildDir);
  });

  it("reads the directory from .env.deploy.local, expanding a leading ~/", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(buildDir, join(home, "chosen"));
    writeFileSync(
      join(repo, ".env.deploy.local"),
      "# the owner's checkout\n\nOTHER=1\nCOUNTERPOISE_BUILD_DIR=\"~/chosen\"\n"
    );
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: undefined, HOME: home } });
    expect(result.code, result.output).toBe(0);
    expect(dockerCwd()).toBe(buildDir);
  });

  it("lets the environment variable win over .env.deploy.local", () => {
    writeFileSync(join(repo, ".env.deploy.local"), `COUNTERPOISE_BUILD_DIR=${join(root, "absent")}\n`);
    const result = deploy();
    expect(result.code, result.output).toBe(0);
    expect(dockerCwd()).toBe(buildDir);
  });

  it("refuses without HOME or an explicit directory", () => {
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: undefined, HOME: undefined } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("neither COUNTERPOISE_BUILD_DIR nor HOME");
  });

  it("refuses a missing production clone rather than creating one without credentials", () => {
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: join(root, "absent") } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("existing production clone");
    expect(result.output).toContain("came from the COUNTERPOISE_BUILD_DIR environment variable");
    expect(result.output).toContain(".env.deploy.local at the root of this checkout");
    expect(git(["tag", "--list"])).toBe("");
  });

  it("names .env.deploy.local as the source when it gives a missing clone", () => {
    writeFileSync(join(repo, ".env.deploy.local"), `COUNTERPOISE_BUILD_DIR=${join(root, "absent")}\n`);
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: undefined } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(`came from ${join(repo, ".env.deploy.local")}`);
  });

  it("names the built-in default as the source when no directory is set", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: undefined, HOME: home } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("came from the built-in default");
  });

  it("refuses a production clone from another origin", () => {
    git(["remote", "set-url", "origin", join(root, "other.git")], buildDir);
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("not a clone of this repository");
    expect(dockerCalls()).toBe("");
  });

  it("refuses production nested inside dev, including symlink spellings", () => {
    const inside = join(repo, "worktrees", "prod");
    mkdirSync(inside, { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(inside, alias);
    const result = deploy({ env: { COUNTERPOISE_BUILD_DIR: alias } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("inside this checkout");
    expect(dockerCalls()).toBe("");
  });

  it("refuses a missing backups directory before publishing", () => {
    rmSync(join(buildDir, "backups"), { recursive: true });
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("backups directory");
    expect(git(["tag", "--list"])).toBe("");
    expect(dockerCalls()).toBe("");
  });

  it("accepts an explicit absolute backups directory", () => {
    const backups = join(root, "backups");
    mkdirSync(backups);
    const result = deploy({ env: { COUNTERPOISE_BACKUPS_DIR: backups } });
    expect(result.code, result.output).toBe(0);
    expect(dockerBackupsDir()).toBe(backups);
  });

  it.each(["relative", "."])("refuses a relative backups directory: %s", (path) => {
    const result = deploy({ env: { COUNTERPOISE_BACKUPS_DIR: path } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("not an absolute path");
    expect(dockerCalls()).toBe("");
  });

  it("validates Compose before publishing the tag", () => {
    writeFileSync(
      join(binDir, "docker"),
      '#!/bin/sh\nif [ "$1" = "compose" ]; then echo "invalid production Compose" >&2; exit 1; fi\nexit 0\n'
    );
    const result = deploy();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("validate production Compose configuration");
    expect(git(["tag", "--list"])).toBe("");
  });
});

describe("the database volume is checked before anything changes", () => {
  /** Asserts that the refused deploy left production and the tags alone. */
  function expectNothingChanged(before: string) {
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(before);
    expect(git(["tag", "--list"])).toBe("");
    expect(dockerCalls()).not.toContain("args=compose");
  }

  it("refuses a missing counterpoise_data volume before production moves", () => {
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy({ env: { DOCKER_NO_VOLUME: "1" } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("the volume counterpoise_data does not exist");
    expect(result.output).toContain(`git -C ${buildDir} merge --ff-only ${mergeCommit}`);
    expect(result.output).toContain(`(cd ${buildDir} && scripts/upgrade-to-sqlite.sh)`);
    expectNothingChanged(before);
  });

  it("refuses DATABASE_URL with no counterpoise.db in the volume, and names the upgrade guide", () => {
    writeFileSync(join(buildDir, ".env.production.local"), "TZ=Europe/London\nDATABASE_URL=postgresql://app@postgres/counterpoise\n");
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy({ env: { DOCKER_RUN_STATUS: "1" } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("sets DATABASE_URL, and the volume counterpoise_data holds no counterpoise.db");
    expect(result.output).toContain("guides/upgrade-to-sqlite.md");
    expect(result.output).toContain(`git -C ${buildDir} merge --ff-only ${mergeCommit}`);
    expect(dockerCalls()).toContain("args=run --rm -v counterpoise_data:/data alpine:3.22 test -e /data/counterpoise.db");
    expectNothingChanged(before);
  });

  it("refuses when it cannot look into the volume", () => {
    writeFileSync(join(buildDir, ".env.production.local"), "DATABASE_URL=postgresql://app@postgres/counterpoise\n");
    const before = git(["rev-parse", "HEAD"], buildDir);
    const result = deploy({ env: { DOCKER_RUN_STATUS: "125" } });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("cannot look for counterpoise.db");
    expectNothingChanged(before);
  });

  it("deploys a converted install that still has DATABASE_URL", () => {
    writeFileSync(join(buildDir, ".env.production.local"), "DATABASE_URL=postgresql://app@postgres/counterpoise\n");
    const result = deploy({ env: { DOCKER_RUN_STATUS: "0" } });
    expect(result.code, result.output).toBe(0);
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(mergeCommit);
  });

  // The first SQLite release: production is fast-forwarded to the release
  // commit by hand, the upgrade script runs there, then the deploy runs.
  it("deploys when production is already at the release commit after the upgrade", () => {
    writeFileSync(join(buildDir, ".env.production.local"), "DATABASE_URL=postgresql://app@postgres/counterpoise\n");
    git(["fetch", "--quiet", "origin"], buildDir);
    git(["merge", "--ff-only", mergeCommit], buildDir);
    const result = deploy({ env: { DOCKER_RUN_STATUS: "0" } });
    expect(result.code, result.output).toBe(0);
    expect(git(["rev-parse", "HEAD"], buildDir)).toBe(mergeCommit);
    expect(dockerCalls()).toContain("args=compose");
  });

  it("does not look into the volume when DATABASE_URL is not set", () => {
    const result = deploy({ env: { DOCKER_RUN_STATUS: "1" } });
    expect(result.code, result.output).toBe(0);
    expect(dockerCalls()).not.toContain("args=run");
  });
});
