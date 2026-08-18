import { describe, expect, it } from "vitest";
import { formatPriceMicros, parsePriceMicros } from "@/lib/pricing";

describe("formatPriceMicros", () => {
  it("formats a whole-dollar price", () => {
    expect(formatPriceMicros(5_000_000)).toBe("$5.000000");
  });

  it("formats a fractional price", () => {
    expect(formatPriceMicros(1_234_567)).toBe("$1.234567");
  });

  it("formats zero", () => {
    expect(formatPriceMicros(0)).toBe("$0.000000");
  });

  it("formats a large price", () => {
    expect(formatPriceMicros(1_000_000_000)).toBe("$1,000.000000");
  });

  it("formats a sub-cent price", () => {
    expect(formatPriceMicros(1)).toBe("$0.000001");
  });
});

describe("parsePriceMicros", () => {
  it("parses a plain decimal string", () => {
    expect(parsePriceMicros("1.234567")).toBe(1_234_567);
  });

  it("parses a currency-formatted string with dollar sign", () => {
    expect(parsePriceMicros("$5.000000")).toBe(5_000_000);
  });

  it("parses a string with commas", () => {
    expect(parsePriceMicros("1,000.000000")).toBe(1_000_000_000);
  });

  it("parses a whole-number string", () => {
    expect(parsePriceMicros("10")).toBe(10_000_000);
  });

  it("parses a negative price", () => {
    expect(parsePriceMicros("-2.5")).toBe(-2_500_000);
  });

  it("returns 0 for an empty string", () => {
    expect(parsePriceMicros("")).toBe(0);
  });

  it("returns 0 for a non-numeric string", () => {
    expect(parsePriceMicros("abc")).toBe(0);
  });

  it("round-trips through format and parse", () => {
    const original = 12_345_678;
    expect(parsePriceMicros(formatPriceMicros(original))).toBe(original);
  });
});
