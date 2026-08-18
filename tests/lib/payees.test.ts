import { describe, it, expect } from "vitest";
import { normalizePayeeName } from "@/lib/payees";

describe("normalizePayeeName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizePayeeName("  Blue   Bottle  ")).toBe("Blue Bottle");
  });

  it("normalizes curly quotes to straight quotes", () => {
    // Right single quotation mark (common in imports)
    expect(normalizePayeeName("Trader Joe's")).toBe("Trader Joe's");

    // Left single quotation mark
    expect(normalizePayeeName("Trader Joe's")).toBe("Trader Joe's");

    // All variations should normalize to the same result
    expect(normalizePayeeName("Trader Joe's")).toBe(
      normalizePayeeName("Trader Joe's")
    );
    expect(normalizePayeeName("Trader Joe's")).toBe(
      normalizePayeeName("Trader Joe's")
    );
  });

  it("normalizes grave accent and acute accent to straight quote", () => {
    expect(normalizePayeeName("Bob`s Diner")).toBe("Bob's Diner");
    expect(normalizePayeeName("Bob´s Diner")).toBe("Bob's Diner");
  });

  it("handles multiple quote types in one name", () => {
    expect(normalizePayeeName("Joe's & Jane's Store")).toBe("Joe's & Jane's Store");
  });
});
