import { resolve } from "node:path";

/**
 * The path of a Rust binary that the tests start. By default it is in
 * `rust-api/target/debug`, where `cargo build` writes it.
 * `COUNTERPOISE_RUST_BIN_DIR` names another directory:
 * `scripts/rust-coverage.mjs` sets it to its instrumented build, which has
 * its own target directory.
 */
export function rustBinary(name: "counterpoise-rust-api" | "ledger-cli"): string {
  return resolve(process.env.COUNTERPOISE_RUST_BIN_DIR || "rust-api/target/debug", name);
}
