import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitFixture } from "./git-fixture";

const restoreGit = gitFixture();
const SCRIPT = resolve(process.cwd(), "scripts/release-tag.sh");

let root: string;
let repo: string;
let origin: string;
/** The release merge on main: package.json goes from 9.9.8 to 9.9.9. */
let mergeCommit: string;
/** The release commit on the release branch, a parent of the merge. */
let releaseHead: string;

function git(args: string[], cwd = repo): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

function releaseTag(commit: string, env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, commit], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** The commit that origin's tag names, peeled, or "" when origin has none. */
function remoteTagCommit(tag = "v9.9.9") {
  const lines = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (!lines) return "";
  const peeled = lines.split("\n").find((line) => line.endsWith("^{}"));
  return (peeled ?? lines).split("\t")[0];
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cp-release-tag-")));
  origin = join(root, "origin.git");
  repo = join(root, "repo");
  restoreGit(root, () => {
    git(["init", "--bare", "-b", "main", origin], root);
    git(["clone", origin, repo], root);
    git(["config", "user.email", "release-tag-test@example.com"]);
    git(["config", "user.name", "Release Tag Test"]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.8" }));
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
    git(["push", "origin", "main"]);

    git(["checkout", "-b", "release/v9.9.9"]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
    git(["add", "-A"]);
    git(["commit", "-m", "release: v9.9.9"]);
    git(["push", "origin", "release/v9.9.9"]);

    git(["checkout", "main"]);
    git(["merge", "--no-ff", "-m", "Merge release/v9.9.9", "release/v9.9.9"]);
    git(["push", "origin", "main"]);
  });
  mergeCommit = git(["rev-parse", "origin/main"]);
  releaseHead = git(["rev-parse", "origin/release/v9.9.9"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release-tag.sh publishes the tag of a release merge once", () => {
  it("tags a release merge, annotated, at the merge commit, and says deploy", () => {
    const output = join(root, "github-output");
    writeFileSync(output, "");

    const result = releaseTag(mergeCommit, { GITHUB_OUTPUT: output });

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("deploy=true");
    expect(remoteTagCommit()).toBe(mergeCommit);
    expect(git(["cat-file", "-t", "v9.9.9"])).toBe("tag");
    expect(readFileSync(output, "utf8")).toBe("deploy=true\ntag=v9.9.9\n");
  });

  it("changes nothing on a re-run, and still says deploy", () => {
    expect(releaseTag(mergeCommit).code).toBe(0);
    const tagObject = git(["ls-remote", "--tags", "origin", "refs/tags/v9.9.9"]);
    git(["tag", "-d", "v9.9.9"]);

    const again = releaseTag(mergeCommit);

    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain("already published");
    expect(again.output).toContain("deploy=true");
    expect(git(["ls-remote", "--tags", "origin", "refs/tags/v9.9.9"]), "the tag moved").toBe(tagObject);
  });

  it("does not tag or deploy a change to main that keeps the version", () => {
    expect(releaseTag(mergeCommit).code).toBe(0);
    writeFileSync(join(repo, "hotfix.txt"), "fix");
    git(["add", "-A"]);
    git(["commit", "-m", "a change that keeps 9.9.9"]);
    git(["push", "origin", "main"]);
    const tagBefore = remoteTagCommit();

    const result = releaseTag(git(["rev-parse", "HEAD"]));

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("not a release");
    expect(result.output).toContain("deploy=false");
    expect(remoteTagCommit()).toBe(tagBefore);
  });

  it("refuses, and moves nothing, when the tag names another commit", () => {
    git(["tag", "-a", "v9.9.9", releaseHead, "-m", "release: v9.9.9"]);
    git(["push", "origin", "refs/tags/v9.9.9"]);

    const result = releaseTag(mergeCommit);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("already points at");
    expect(result.output).not.toContain("deploy=");
    expect(remoteTagCommit()).toBe(releaseHead);
  });

  it("refuses a commit that main does not hold", () => {
    git(["checkout", "-b", "elsewhere", releaseHead]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.10" }));
    git(["add", "-A"]);
    git(["commit", "-m", "not on main"]);

    const result = releaseTag(git(["rev-parse", "HEAD"]));

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("is not on origin/main");
    expect(git(["ls-remote", "--tags", "origin"])).toBe("");
  });
});
