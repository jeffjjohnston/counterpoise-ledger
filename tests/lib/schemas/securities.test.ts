import { describe, it, expect } from "vitest";
import {
  createSecuritySchema,
  updateSecuritySchema,
  securityPriceListQuery,
  securitySplitListQuery,
} from "@/lib/schemas/securities";

describe("createSecuritySchema", () => {
  it("accepts a minimal valid security", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    expect(r.success).toBe(true);
  });

  it("accepts fetchPrices when provided", () => {
    const r = createSecuritySchema.safeParse({
      name: "Index Fund",
      symbol: "IXYZ",
      securityType: "etf",
      fetchPrices: false,
    });
    expect(r.success).toBe(true);
    expect(r.data!.fetchPrices).toBe(false);
  });

  it("rejects a missing name with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      symbol: "ACME",
      securityType: "stock",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects an empty name with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "",
      symbol: "ACME",
      securityType: "stock",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects a missing symbol with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      securityType: "stock",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Symbol is required");
  });

  it("rejects an empty symbol with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "",
      securityType: "stock",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Symbol is required");
  });

  it("rejects a missing securityType with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "ACME",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "securityType must be one of: etf, mutual_fund, stock"
    );
  });

  it("rejects an unknown securityType with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "bond",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "securityType must be one of: etf, mutual_fund, stock"
    );
  });

  it("accepts every real securityType value", () => {
    for (const securityType of ["etf", "mutual_fund", "stock"]) {
      const r = createSecuritySchema.safeParse({
        name: "Acme Corp",
        symbol: "ACME",
        securityType,
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects a non-boolean fetchPrices with the ported message", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
      fetchPrices: "yes",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("fetchPrices must be a boolean");
  });

  it("accepts an omitted fetchPrices (route/DB default applies)", () => {
    const r = createSecuritySchema.safeParse({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    expect(r.success).toBe(true);
    expect(r.data!.fetchPrices).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // lib/securities.ts's createSecurity() reads `input.name` via property
    // access, not destructuring. For an array/string/number/boolean, that
    // auto-boxes to undefined without throwing (name normalizes to "", same
    // as a body simply missing the key) — only a literal `null` body threw.
    // All five had — or, for null, now gain — the same "Name is required"
    // message at 400.
    const r = createSecuritySchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });
});

describe("updateSecuritySchema", () => {
  it("accepts an empty update (no fields changed)", () => {
    const r = updateSecuritySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a partial update", () => {
    const r = updateSecuritySchema.safeParse({ name: "New Name" });
    expect(r.success).toBe(true);
  });

  it("accepts an empty name (PUT never guarded this, unlike POST)", () => {
    const r = updateSecuritySchema.safeParse({ name: "" });
    expect(r.success).toBe(true);
  });

  it("accepts an empty symbol (PUT never guarded this, unlike POST)", () => {
    const r = updateSecuritySchema.safeParse({ symbol: "" });
    expect(r.success).toBe(true);
  });

  it("rejects a non-string name", () => {
    const r = updateSecuritySchema.safeParse({ name: 5 });
    expect(r.success).toBe(false);
  });

  it("accepts every real securityType value", () => {
    for (const securityType of ["etf", "mutual_fund", "stock"]) {
      const r = updateSecuritySchema.safeParse({ securityType });
      expect(r.success).toBe(true);
    }
  });

  it("rejects an unknown securityType, closing a gap PUT never guarded before", () => {
    const r = updateSecuritySchema.safeParse({ securityType: "bond" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "securityType must be one of: etf, mutual_fund, stock"
    );
  });

  it("rejects a non-boolean fetchPrices with the route's own ported message (capital F)", () => {
    const r = updateSecuritySchema.safeParse({ fetchPrices: "yes" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Fetch prices must be a boolean");
  });

  it("accepts a valid fetchPrices", () => {
    const r = updateSecuritySchema.safeParse({ fetchPrices: false });
    expect(r.success).toBe(true);
  });
});

describe("securityPriceListQuery", () => {
  it("falls back to the default limit/offset when both are absent", () => {
    const r = securityPriceListQuery.safeParse({ limit: undefined, offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 50, offset: 0 });
  });

  it("accepts valid limit/offset", () => {
    const r = securityPriceListQuery.safeParse({ limit: "10", offset: "5" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 10, offset: 5 });
  });

  it("clamps a limit above the max to 200 rather than falling back to the default", () => {
    const r = securityPriceListQuery.safeParse({ limit: "500", offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(200);
  });

  it("falls back to the default limit for a non-numeric value instead of 400ing", () => {
    const r = securityPriceListQuery.safeParse({ limit: "abc", offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(50);
  });

  it("falls back to the default limit for zero or negative values", () => {
    const r = securityPriceListQuery.safeParse({ limit: "0", offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(50);
  });

  it("falls back to offset 0 for a negative or non-numeric offset instead of 400ing", () => {
    const r1 = securityPriceListQuery.safeParse({ limit: undefined, offset: "-5" });
    expect(r1.data!.offset).toBe(0);
    const r2 = securityPriceListQuery.safeParse({ limit: undefined, offset: "abc" });
    expect(r2.data!.offset).toBe(0);
  });
});

describe("securitySplitListQuery", () => {
  it("falls back to the default limit/offset when both are absent", () => {
    const r = securitySplitListQuery.safeParse({ limit: undefined, offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 50, offset: 0 });
  });

  it("accepts valid limit/offset", () => {
    const r = securitySplitListQuery.safeParse({ limit: "2", offset: "0" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 2, offset: 0 });
  });
});
