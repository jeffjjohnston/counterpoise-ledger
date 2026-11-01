import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { TEST_DATABASE_ROOT, ledgerCli } from "./test-database";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("ledgerCli", () => {
  // A checkout with no rust-api/target/ has no binary. spawnSync then gives
  // status null and ENOENT in result.error, and the database suites failed
  // with "failed (null): undefined undefined".
  it("names the missing binary and the build command", () => {
    const missing = join(TEST_DATABASE_ROOT, "no-such-dir", "ledger-cli");
    expect(() => ledgerCli(["--help"], join(TEST_DATABASE_ROOT, "unused.db"), {}, missing)).toThrow(
      new RegExp(`not found at ${escape(missing)}.*cargo build --manifest-path rust-api/Cargo.toml -p ledger-cli`, "s")
    );
  });
});
