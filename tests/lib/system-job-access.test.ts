import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_DIR = "rust-api/server/src";

/**
 * `BookAccess::for_system_job` gives write access to a book with no signed-in
 * user (rust-api/server/src/book_scope.rs). The compiler cannot limit who
 * calls a `pub(crate)` function, so this test does: only the scheduled jobs
 * may call it. A route that a member calls gets its access from
 * `authenticate_book`. See guides/api-route-patterns.md.
 */
const ALLOWED_CALLERS = [
  "routes/cron.rs run_recurring",
  "routes/cron.rs sync_connections",
  "routes/weekly_review.rs review_books",
  "typesafe.rs cleanup_batch",
];

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return rustFiles(path);
    return path.endsWith(".rs") ? [path] : [];
  });
}

/** Each call of `for_system_job`, as "<file> <function that holds it>". */
function systemJobCallers(): string[] {
  const callers: string[] = [];
  for (const path of rustFiles(SERVER_DIR)) {
    const relative = path.slice(SERVER_DIR.length + 1);
    if (relative === "book_scope.rs") continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/for_system_job\s*\(/g)) {
      const before = source.slice(0, match.index);
      const functions = [...before.matchAll(/\bfn\s+(\w+)/g)];
      callers.push(`${relative} ${functions.at(-1)?.[1] ?? "<none>"}`);
    }
  }
  return callers.sort();
}

describe("BookAccess::for_system_job", () => {
  it("is called only by the scheduled jobs", () => {
    expect(systemJobCallers()).toEqual(ALLOWED_CALLERS);
  });

  it("is not called in book_scope.rs outside its tests", () => {
    const source = readFileSync(join(SERVER_DIR, "book_scope.rs"), "utf8");
    // The production code ends at the tests module. A `#[cfg(test)]` on one
    // function (for example `InBook::unchecked`) does not end it.
    const testsModule = source.search(/#\[cfg\(test\)\]\s*mod tests\b/);
    expect(testsModule).toBeGreaterThan(0);
    const code = source.slice(0, testsModule);
    const calls = [...code.matchAll(/for_system_job\s*\(/g)].length;
    // The definition itself is the one match.
    expect(calls).toBe(1);
  });
});
