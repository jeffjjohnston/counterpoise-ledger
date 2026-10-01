import { rmSync } from "node:fs";
import { runDirectory } from "./helpers/test-database";

/** Removes this run's database files when the run ends. */
export default function setup() {
  return () => {
    const runId = process.env.COUNTERPOISE_TEST_RUN_ID;
    if (runId) rmSync(runDirectory(runId), { recursive: true, force: true });
  };
}
