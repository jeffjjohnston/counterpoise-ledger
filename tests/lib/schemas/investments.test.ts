import { describe, it, expect } from "vitest";
import { accountValuesQuery, positionsQuery } from "@/lib/schemas/investments";

describe("accountValuesQuery", () => {
  it("accepts an empty query", () => {
    const r = accountValuesQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.asOfDate).toBeUndefined();
  });

  it("accepts a valid asOfDate", () => {
    const r = accountValuesQuery.safeParse({ asOfDate: "2025-01-10" });
    expect(r.success).toBe(true);
    expect(r.data!.asOfDate).toBe("2025-01-10");
  });

  it("rejects a malformed asOfDate", () => {
    const r = accountValuesQuery.safeParse({ asOfDate: "not-a-date" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid ISO date");
  });
});

describe("positionsQuery", () => {
  it("a missing accountId parses to undefined, not a coerced 0", () => {
    const r = positionsQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBeUndefined();
  });

  it("accepts a positive integer accountId string", () => {
    const r = positionsQuery.safeParse({ accountId: "5" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(5);
  });

  it("rejects a non-numeric accountId with the ported message", () => {
    const r = positionsQuery.safeParse({ accountId: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects an explicit empty-string accountId rather than coercing it to 0", () => {
    const r = positionsQuery.safeParse({ accountId: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects a fractional accountId", () => {
    const r = positionsQuery.safeParse({ accountId: "5.5" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("accepts a negative accountId (never rejected by the original guard)", () => {
    const r = positionsQuery.safeParse({ accountId: "-3" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(-3);
  });

  it("accepts accountId 0 (never rejected by the original guard)", () => {
    const r = positionsQuery.safeParse({ accountId: "0" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(0);
  });
});
