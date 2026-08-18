import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const sharedOptions = {
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

const targets = [
  { entry: "mcp/server.ts", out: "dist/mcp-server.mjs" },
  { entry: "scripts/rebuild-lots.ts", out: "dist/rebuild-lots.mjs" },
];

for (const target of targets) {
  await esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(root, target.entry)],
    outfile: resolve(root, target.out),
  });
  console.log(`Bundled ${target.entry} to ${target.out}`);
}
