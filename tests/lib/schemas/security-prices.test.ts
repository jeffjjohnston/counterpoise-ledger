import { describe, it, expect } from "vitest";
import {
  updateSecurityPriceSchema,
  bulkPricesSchema,
  tiingoFetchSchema,
} from "@/lib/schemas/security-prices";

describe("updateSecurityPriceSchema", () => {
  it("accepts a valid update", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2025-01-15",
      priceMicros: 6_000_000,
    });
    expect(r.success).toBe(true);
  });

  it("accepts source alongside priceMicros", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2025-01-15",
      priceMicros: 7_000_000,
      source: "tiingo",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing priceDate with the ported message", () => {
    const r = updateSecurityPriceSchema.safeParse({ priceMicros: 5_000_000 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceDate is required");
  });

  it("rejects an empty priceDate with the ported message", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "",
      priceMicros: 5_000_000,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceDate is required");
  });

  it("rejects a non-calendar priceDate (e.g. 'not-a-date') instead of writing it verbatim", () => {
    // The original guard only checked presence/type, not calendar format —
    // "not-a-date" used to be accepted and would reach the INSERT/UPDATE
    // verbatim. This route is a write path (see the file's header comment):
    // "latest price" is resolved by plain string comparison
    // (lib/investments.ts), so a non-calendar priceDate can sort above every
    // real date and silently become the security's market price. z.iso.date()
    // now rejects it at 400 instead.
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "not-a-date",
      priceMicros: 5_000_000,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceDate is required");
  });

  it("rejects a syntactically valid but calendar-impossible priceDate ('2026-02-30')", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2026-02-30",
      priceMicros: 5_000_000,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceDate is required");
  });

  it("still accepts a genuine calendar date", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2026-08-12",
      priceMicros: 5_000_000,
    });
    expect(r.success).toBe(true);
    expect(r.data!.priceDate).toBe("2026-08-12");
  });

  it("rejects a missing priceMicros with the ported message", () => {
    const r = updateSecurityPriceSchema.safeParse({ priceDate: "2025-01-15" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid priceMicros");
  });

  it("rejects a negative priceMicros with the ported message", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2025-01-15",
      priceMicros: -1000,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid priceMicros");
  });

  it("rejects a zero priceMicros with the ported message", () => {
    const r = updateSecurityPriceSchema.safeParse({
      priceDate: "2025-01-15",
      priceMicros: 0,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid priceMicros");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ priceDate, priceMicros, source }`
    // straight off the parsed body. An array/string/number/boolean
    // auto-boxes without throwing (priceDate comes out undefined, same as a
    // body simply missing the key) — only a literal `null` body threw. All
    // five had — or, for null, now gain — the same "priceDate is required"
    // message at 400.
    const r = updateSecurityPriceSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceDate is required");
  });
});

describe("bulkPricesSchema", () => {
  it("accepts a valid list of price updates", () => {
    const r = bulkPricesSchema.safeParse({
      priceUpdates: [
        { securityId: 1, priceMicros: 11_500_000, priceDate: "2025-01-01" },
        { securityId: 1, priceMicros: 12_250_000, priceDate: "2025-01-02" },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data!.priceUpdates).toHaveLength(2);
  });

  it("rejects a non-array priceUpdates with the ported message", () => {
    const r = bulkPricesSchema.safeParse({ priceUpdates: null });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceUpdates must be an array");
  });

  it("filters out invalid entries and keeps the valid ones", () => {
    const r = bulkPricesSchema.safeParse({
      priceUpdates: [
        { securityId: "not-a-number", priceMicros: 100, priceDate: "2025-01-01" },
        { securityId: 1, priceMicros: 100, priceDate: "2025-01-02" },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data!.priceUpdates).toEqual([
      { securityId: 1, priceMicros: 100, priceDate: "2025-01-02" },
    ]);
  });

  it("rejects with the ported message when every entry is invalid", () => {
    const r = bulkPricesSchema.safeParse({
      priceUpdates: [
        { securityId: 1, priceMicros: null, priceDate: "2025-01-01" },
        { securityId: 1, priceMicros: 0, priceDate: "2025-01-02" },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("No valid price updates provided");
  });

  it("rejects with the ported message for an empty array", () => {
    const r = bulkPricesSchema.safeParse({ priceUpdates: [] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("No valid price updates provided");
  });

  it("filters out a non-integer securityId", () => {
    const r = bulkPricesSchema.safeParse({
      priceUpdates: [{ securityId: 1.5, priceMicros: 100, priceDate: "2025-01-01" }],
    });
    expect(r.success).toBe(false);
  });

  it("filters out a calendar-invalid but regex-matching priceDate", () => {
    // "2026-02-30" matched the original /^\d{4}-\d{2}-\d{2}$/ regex and would
    // have been written to the database; z.iso.date() rejects it for real.
    const r = bulkPricesSchema.safeParse({
      priceUpdates: [{ securityId: 1, priceMicros: 100, priceDate: "2026-02-30" }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("No valid price updates provided");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ priceUpdates } = body` straight off
    // the parsed body. An array/string/number/boolean auto-boxes without
    // throwing (priceUpdates comes out undefined, same as a body simply
    // missing the key) — only a literal `null` body threw. All five had —
    // or, for null, now gain — the same "priceUpdates must be an array"
    // message at 400.
    const r = bulkPricesSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("priceUpdates must be an array");
  });
});

describe("tiingoFetchSchema", () => {
  it("accepts a non-empty symbols array", () => {
    const r = tiingoFetchSchema.safeParse({ symbols: ["ACME", "VTI"] });
    expect(r.success).toBe(true);
  });

  it("rejects an empty symbols array with the ported message", () => {
    const r = tiingoFetchSchema.safeParse({ symbols: [] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("symbols must be a non-empty array");
  });

  it("rejects a non-array symbols with the ported message", () => {
    const r = tiingoFetchSchema.safeParse({ symbols: "ACME" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("symbols must be a non-empty array");
  });

  it("does not validate element types (the original guard never did)", () => {
    const r = tiingoFetchSchema.safeParse({ symbols: [1, 2, 3] });
    expect(r.success).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ symbols } = body` straight off the
    // parsed body. An array/string/number/boolean auto-boxes without
    // throwing (symbols comes out undefined, same as a body simply missing
    // the key) — only a literal `null` body threw. All five had — or, for
    // null, now gain — the same "symbols must be a non-empty array" message
    // at 400.
    const r = tiingoFetchSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("symbols must be a non-empty array");
  });
});
