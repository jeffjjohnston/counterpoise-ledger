import { describe, expect, it } from "vitest";
import { parseImportArgs } from "@/scripts/import-moneydance/args";

describe("Moneydance import args", () => {
  it("parses --overwrite when provided", () => {
    const parsed = parseImportArgs(["tests/fixtures/moneydance-sample.json", "--book-id", "42", "--overwrite", "--verbose"]);

    expect(parsed.filePath).toBe("tests/fixtures/moneydance-sample.json");
    expect(parsed.bookId).toBe(42);
    expect(parsed.overwrite).toBe(true);
    expect(parsed.options.verbose).toBe(true);
  });

  it("defaults overwrite to false", () => {
    const parsed = parseImportArgs(["tests/fixtures/moneydance-sample.json", "--book-id", "7"]);

    expect(parsed.overwrite).toBe(false);
    expect(parsed.options.dryRun).toBe(false);
    expect(parsed.options.importInactive).toBe(true);
    expect(parsed.options.importHidden).toBe(true);
  });

  it("throws when --book-id is missing", () => {
    expect(() => parseImportArgs(["tests/fixtures/moneydance-sample.json"])).toThrow("Error: --book-id <id> is required");
  });
});
