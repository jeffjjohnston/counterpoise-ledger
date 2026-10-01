import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

// The client gets the WASM from the base64 copy in the wasm-client chunk.
// Vite once also emitted ledger_core_bg-*.wasm (1.4 MB) that no code loaded.
// See vite.config.ts, dropUnusedWasmAsset.
describe("client build assets", () => {
  const outDir = mkdtempSync(join(tmpdir(), "cp-client-build-"));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("emits no .wasm file", async () => {
    await build({ logLevel: "silent", build: { outDir, emptyOutDir: true } });
    const assets = readdirSync(join(outDir, "assets"));
    expect(assets.filter((name) => name.endsWith(".wasm"))).toEqual([]);
    expect(assets.some((name) => /^wasm-client-.*\.js$/.test(name))).toBe(true);
  }, 120_000);
});
