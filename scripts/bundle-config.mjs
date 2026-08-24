import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root — the resolve base for the `@/` alias below. */
export const root = resolve(__dirname, "..");

/**
 * The esbuild options every Node entrypoint bundle is built with.
 *
 * Shared with tests/mcp/bundle-safety.test.ts on purpose. That test inspects
 * the bundled text for things that must never ship in it (a DROP SCHEMA, a
 * main-module guard that fires when the bundle is the entry). It can only make
 * that claim about the artifact Docker ships if it builds with exactly this
 * configuration, so both sides import it rather than keeping a copy.
 *
 * The JSDoc type is load-bearing: this file is plain JS, so without it every
 * string here widens to `string` and the TypeScript side fails to type-check
 * against esbuild's literal unions (`packages: "external" | "bundle"`).
 *
 * @type {import("esbuild").BuildOptions}
 */
export const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Keep node_modules external — installed separately in Docker runner
  packages: "external",
  plugins: [
    {
      name: "resolve-at-alias",
      setup(build) {
        // Rewrite @/foo to ./foo and re-resolve from project root
        // so esbuild handles .ts extension resolution
        build.onResolve({ filter: /^@\// }, async (args) => {
          const rewritten = "./" + args.path.slice(2);
          return build.resolve(rewritten, { resolveDir: root, kind: args.kind });
        });
      },
    },
  ],
};

/** Every entrypoint bundled into the Docker image. */
export const targets = [
  { entry: "mcp/server.ts", out: "dist/mcp-server.mjs" },
  { entry: "scripts/rebuild-lots.ts", out: "dist/rebuild-lots.mjs" },
];
