import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Build a suite's initial Git history once, then copy it into each test's
 * private directory. Copy objects and refs (no hardlinks or alternates), so
 * resets, pushes, tags and even object deletion cannot affect another test.
 * Only repo/ and origin.git/ are cached; path-dependent stubs belong outside
 * this callback and must be written for each test.
 */
export function gitFixture() {
  let snapshot: string | undefined;
  afterAll(() => {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  });
  return (root: string, build: () => void) => {
    if (snapshot) {
      for (const name of ["repo", "origin.git"]) {
        cpSync(join(snapshot, name), join(root, name), { recursive: true });
      }
    } else {
      build();
      snapshot = mkdtempSync(join(tmpdir(), "cp-git-snapshot-"));
      for (const name of ["repo", "origin.git"]) {
        cpSync(join(root, name), join(snapshot, name), { recursive: true });
      }
    }
    // Rebind every copy. An absolute URL also works from release worktrees
    // and matches the origin recorded by deploy's permanent clone.
    execFileSync("git", ["remote", "set-url", "origin", join(root, "origin.git")], {
      cwd: join(root, "repo"), stdio: "pipe",
    });
  };
}
