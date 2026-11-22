import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAccountTree } from "@/lib/wasm-client";

describe("the browser copy of the core", () => {
  // The server sorts names with ICU collation data. That data is about
  // 1.2 MB, and a browser has the same order in `localeCompare`. The browser
  // module must therefore not carry it: with the data, the module was
  // 1,654,439 bytes; without it, about 500,000.
  it("does not carry the collation data", () => {
    const { size } = statSync("lib/wasm/generated/ledger_core_bg.wasm");
    expect(size).toBeGreaterThan(100_000);
    expect(size).toBeLessThan(800_000);
  });

  // The order of English collation, derived by hand: punctuation, then
  // digits (as text: "10" before "9"), then letters without regard to case
  // or accent, with lower case and no accent first among equal letters.
  it("sorts account names as the server does", () => {
    const expected = [
      "_Under", "10 Main St", "9 Elm St", "apple", "Apple", "banana", "Bank",
      "eclair", "Éclair", "éclair 2", "Zebra", "Zoë",
    ];
    // The input order is not the sorted order of code units or of the list above.
    const shuffled = [
      "Zoë", "Bank", "éclair 2", "9 Elm St", "Apple", "_Under", "Zebra",
      "Éclair", "banana", "10 Main St", "eclair", "apple",
    ];
    const accounts = shuffled.map((name, index) => ({ id: index + 1, name, type: "asset", parentId: null }));
    const tree = buildAccountTree(accounts as unknown as Parameters<typeof buildAccountTree>[0]);
    expect(tree.map((node) => node.name)).toEqual(expected);
  });
});
