import * as esbuild from "esbuild";
import { resolve } from "path";
import { root, sharedOptions, targets } from "./bundle-config.mjs";

for (const target of targets) {
  await esbuild.build({
    ...sharedOptions,
    entryPoints: [resolve(root, target.entry)],
    outfile: resolve(root, target.out),
  });
  console.log(`Bundled ${target.entry} to ${target.out}`);
}
