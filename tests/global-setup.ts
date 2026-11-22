import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { runDirectory } from "./helpers/test-database";

/**
 * Before the run: builds the browser copy of the Rust core, which many tests
 * import through `lib/wasm-client.ts`. It runs here, not in an npm `pre`
 * script, so that `npx vitest` gets it too and no test runs on the core of
 * an earlier commit. The script starts no tool when the core did not change.
 *
 * After the run: removes this run's database files.
 */
export default function setup() {
  execFileSync(process.execPath, [resolve(import.meta.dirname, "../scripts/build-core-wasm.mjs")], {
    stdio: "inherit",
  });
  return () => {
    const runId = process.env.COUNTERPOISE_TEST_RUN_ID;
    if (runId) rmSync(runDirectory(runId), { recursive: true, force: true });
  };
}
