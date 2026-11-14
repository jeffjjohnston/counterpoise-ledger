import { describe, expect, it } from "vitest";
import { getInvestmentGrossAmountCents } from "@/lib/investment-arithmetic";

// lib/wasm-client.ts uses this function when JSON cannot carry the input to
// the WASM module. It must give the same cents as gross_amount_cents() in
// rust-api/core/src/accounting.rs, which the corpus checks.
describe("getInvestmentGrossAmountCents (JavaScript fallback)", () => {
  it("calculates gross amount in cents from micros", () => {
    expect(getInvestmentGrossAmountCents(1_500_000, 12_500_000)).toBe(1875);
  });

  it("rounds a half-cent tie up", () => {
    // 25 shares at $0.0014 is exactly 3.5 cents.
    expect(getInvestmentGrossAmountCents(25_000_000, 1400)).toBe(4);
  });

  it("stays exact when shares x price is more than 2^53", () => {
    expect(getInvestmentGrossAmountCents(426_354_381_896, 3_225_163_023)).toBe(137_506_238_718);
  });
});
