import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitFixture } from "./git-fixture";

const restore = gitFixture();
it("keeps checkout, remote refs and objects independent of previous copies", () => {
  const roots = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), "cp-snapshot-test-")));
  const git = (root: string, ...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: "pipe",
  }).trim();
  let builds = 0;
  try {
    for (const root of roots) {
      restore(root, () => {
        builds++;
        git(root, "init", "--bare", "-b", "main", "origin.git");
        git(root, "clone", "origin.git", "repo");
        const repo = join(root, "repo");
        git(repo, "config", "user.name", "Test");
        git(repo, "config", "user.email", "test@example.invalid");
        writeFileSync(join(repo, "file"), "original");
        git(repo, "add", ".");
        git(repo, "commit", "-m", "base");
        git(repo, "push", "origin", "main");
      });
      const repo = join(root, "repo");
      expect(readFileSync(join(repo, "file"), "utf8")).toBe("original");
      expect(git(repo, "log", "-1", "--format=%s")).toBe("base");
      expect(git(repo, "ls-remote", "--tags", "origin")).toBe("");
      git(repo, "tag", "test-tag");
      git(repo, "push", "origin", "test-tag");
      expect(git(repo, "ls-remote", "--tags", "origin")).toContain("refs/tags/test-tag");
      writeFileSync(join(repo, "file"), "changed");
      // Corrupt a loose object in place: hardlinked snapshots would corrupt too.
      const sha = git(repo, "rev-parse", "HEAD");
      const object = join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));
      chmodSync(object, 0o644);
      writeFileSync(object, "broken");
    }
    expect(builds).toBe(1);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
