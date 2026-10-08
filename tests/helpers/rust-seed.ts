import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { workerDatabasePath } from "./test-database";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");

/** The date that the seed tests pin. The household rows at this date are the rows of the fixed 2023-2025 seed. */
export const PINNED_TODAY = "2025-12-31";

/** Run the Rust seed against this worker's database, in this process's zone. */
export async function rustSeed(...args: string[]) {
  // The pin goes first, so that a flag with a missing value still reads the end of the list.
  const pinned = args.includes("--today") ? args : ["--today", PINNED_TODAY, ...args];
  return run(CLI, ["seed", ...pinned], {
    env: {
      ...process.env,
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}
