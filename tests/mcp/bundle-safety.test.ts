// @vitest-environment node
//
// Not jsdom (the project-wide default). jsdom installs its own TextEncoder,
// whose output fails esbuild's `new TextEncoder().encode("") instanceof
// Uint8Array` startup invariant, and esbuild refuses to load at all.
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { resolve } from "path";
// The same configuration scripts/bundle-node-entrypoints.mjs builds with, not a
// copy of it. If that script's options drift, this test drifts with them, which
// is the only way its claims stay claims about the artifact Docker actually
// ships (Dockerfile: dist/mcp-server.mjs → /app/mcp-server.mjs).
import { root, sharedOptions, targets } from "@/scripts/bundle-config.mjs";

/**
 * Guards the *bundled* Node entrypoints, which no other test looks at.
 *
 * Every other gate — `npm run mcp:dev`, vitest, tsc — runs unbundled source,
 * where each module keeps its own identity. Bundling collapses them, and two
 * things that are harmless in a module graph become live hazards in a single
 * file:
 *
 *  1. A top-level main-module guard (`process.argv[1] === fileURLToPath(
 *     import.meta.url)`) resolves against the BUNDLE's path once inlined. The
 *     documented production invocation is `node /app/mcp-server.mjs`, so such
 *     a guard belonging to some unrelated module fires on MCP server startup.
 *  2. Anything that guard runs then runs in production. db/seed.ts's `main()`
 *     drops the public and drizzle schemas.
 *
 * That exact pair shipped: lib/books.ts imports seedBook from @/db/seed for
 * create_demo_book, which pulled all of db/seed.ts — DROP SCHEMA and
 * main-module guard included — into the MCP server bundle. The fix was to move
 * the CLI half of db/seed.ts into db/seed-cli.ts. This test is what notices if
 * anything like it comes back.
 */
async function bundleText(entry: string): Promise<string> {
  const result = await esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(root, entry)],
    write: false,
    outfile: resolve(root, "dist/__bundle-safety-check.mjs"),
  });

  // write:false guarantees outputFiles; assert rather than assume, so a
  // config change that starts writing to disk fails here instead of silently
  // checking nothing.
  expect(result.outputFiles ?? []).toHaveLength(1);
  return result.outputFiles![0].text;
}

describe("bundled Node entrypoints", () => {
  // Sanity: the shared config really does cover both shipped bundles, so a
  // target added to the bundler is automatically covered here too.
  it("checks every entrypoint the bundler ships", () => {
    expect(targets.map((target) => target.entry).sort()).toEqual([
      "mcp/server.ts",
      "scripts/rebuild-lots.ts",
    ]);
  });

  for (const target of targets) {
    describe(target.entry, () => {
      it("contains no DROP SCHEMA", async () => {
        const text = await bundleText(target.entry);
        expect(text).not.toMatch(/DROP\s+SCHEMA/i);
      });

      it("contains no import.meta.url main-module guard", async () => {
        const text = await bundleText(target.entry);

        // Assert on the ingredients rather than one spelling of the guard:
        // any main-module check needs both the process entry path and the
        // module's own URL, however it words the comparison.
        const usesArgvEntry = /process\.argv\[1\]/.test(text);
        const usesModuleUrl = /import\.meta\.url/.test(text);

        expect(
          usesArgvEntry && usesModuleUrl,
          "bundle compares process.argv[1] against import.meta.url — a main-module " +
            "guard that fires when this bundle IS the entrypoint (node /app/mcp-server.mjs)"
        ).toBe(false);

        // And the specific shape that shipped, so a rename of the variable
        // still trips at least one of the two.
        expect(text).not.toMatch(/isMainModule/);
      });

      // Any top-level statement in a bundle runs the moment the bundle is
      // imported, which for these two artifacts means "on production startup".
      // A top-level `await runMigrations()` is invisible to both checks above.
      // esbuild's ESM output preserves indentation, so a line beginning at
      // column 0 with `await ` is top level; both bundles have zero today.
      //
      // Limit worth knowing: this catches a top-level *await*. A synchronous
      // top-level call still slips through, which is why the DROP SCHEMA check
      // above is kept as its own assertion rather than folded into this one.
      it("runs no top-level await", async () => {
        const text = await bundleText(target.entry);
        const offenders = text.split("\n").filter((line) => /^await /.test(line));
        expect(
          offenders,
          "top-level await in a bundle runs on import — i.e. on production startup"
        ).toEqual([]);
      });

      // Tighter rule for the MCP server bundle alone. The paired check above
      // needs process.argv[1] AND import.meta.url, but this codebase's own
      // main-guard idiom uses argv[1] with neither — scripts/rebuild-lots.ts's
      // `if (process.argv[1]?.includes("rebuild-lots"))`. Copied into anything
      // mcp/server.ts imports, it would fire under `node /app/mcp-server.mjs`
      // and the paired check would not see it.
      //
      // Scoped to this one target on purpose: the rebuild-lots bundle contains
      // that argv[1] read by design, so asserting it for every target would
      // fail on a correct artifact.
      if (target.entry === "mcp/server.ts") {
        it("reads process.argv[1] nowhere at all", async () => {
          const text = await bundleText(target.entry);
          expect(
            /process\.argv\[1\]/.test(text),
            "the MCP server bundle reads process.argv[1] — a main-module guard in any " +
              "spelling fires when this bundle IS the entrypoint"
          ).toBe(false);
        });
      }
    });
  }
});
