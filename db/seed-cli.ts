/**
 * CLI entry for the sample-data seed. Run by `npm run db:seed`.
 *
 *   npm run db:seed                  Full destructive reset + seed.
 *   npm run db:seed -- --book-id 2   Replace the contents of book 2 only.
 *
 * The seed itself is `ledger-cli seed` (rust-api/db/src/seed.rs). Rust never
 * applies DDL, so for a full reset this script drops the schemas and runs the
 * Drizzle migrations first. `cargo run` builds the CLI when its source has
 * changed. The Rust CLI checks the arguments and the book.
 *
 * The main-module guard lives here, in a file that nothing imports, so it can
 * only ever be true when a human runs it directly. A guard in an imported
 * module once resolved against a bundle's own path in the former TypeScript
 * MCP server, and would have run the destructive seed against production.
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { closeDb } from "./index";
import { resetDatabase } from "./reset";

const CARGO_MANIFEST = fileURLToPath(new URL("../rust-api/Cargo.toml", import.meta.url));

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (!args.includes("--book-id")) {
    await resetDatabase();
    await closeDb();
  }

  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--locked", "--manifest-path", CARGO_MANIFEST, "-p", "ledger-cli", "--", "seed", ...args],
    { stdio: "inherit" }
  );
  if (result.error) {
    console.error("Seed failed: could not run cargo:", result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
