import { describe, it, expect } from "vitest";
import { parseStockSplitRatio } from "@/scripts/import-moneydance/utils/format";

describe("parseStockSplitRatio", () => {
  it("parses forward splits from old/new", () => {
    expect(parseStockSplitRatio("1", "4", "4.0")).toEqual({
      numerator: 4,
      denominator: 1,
    });
  });

  it("parses reverse splits from old/new", () => {
    expect(parseStockSplitRatio("2", "1", "0.5")).toEqual({
      numerator: 1,
      denominator: 2,
    });
  });

  it("uses ratio to detect swapped old/new", () => {
    expect(parseStockSplitRatio("7", "1", "7")).toEqual({
      numerator: 7,
      denominator: 1,
    });
  });

  it("uses ratio when old and new are the same", () => {
    expect(parseStockSplitRatio("1", "1", "3.0")).toEqual({
      numerator: 3,
      denominator: 1,
    });
  });
});
