import { describe, it, expect } from "vitest";
import {
  reportDataQuery,
  incomeStatementQuery,
  realizedGainsQuery,
} from "@/lib/schemas/reports";

describe("reportDataQuery", () => {
  it("accepts an empty query (no filters)", () => {
    const r = reportDataQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      startDate: undefined,
      endDate: undefined,
      accountIds: undefined,
      accountTypes: undefined,
    });
  });

  it("accepts valid startDate/endDate", () => {
    const r = reportDataQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed startDate", () => {
    const r = reportDataQuery.safeParse({ startDate: "not-a-date" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid ISO date");
  });

  it("rejects an out-of-range calendar date", () => {
    const r = reportDataQuery.safeParse({ endDate: "2025-13-45" });
    expect(r.success).toBe(false);
  });

  it("parses accountIds into a number array, dropping non-numeric entries", () => {
    const r = reportDataQuery.safeParse({ accountIds: "1,abc,3" });
    expect(r.success).toBe(true);
    expect(r.data!.accountIds).toEqual([1, 3]);
  });

  it("treats an accountIds value with nothing usable as absent (never 400s)", () => {
    const r = reportDataQuery.safeParse({ accountIds: "abc,def" });
    expect(r.success).toBe(true);
    expect(r.data!.accountIds).toBeUndefined();
  });

  it("filters accountTypes to the known enum values, dropping the rest", () => {
    const r = reportDataQuery.safeParse({ accountTypes: "asset,bogus,expense" });
    expect(r.success).toBe(true);
    expect(r.data!.accountTypes).toEqual(["asset", "expense"]);
  });

  it("treats an accountTypes value with nothing usable as absent (never 400s)", () => {
    const r = reportDataQuery.safeParse({ accountTypes: "bogus" });
    expect(r.success).toBe(true);
    expect(r.data!.accountTypes).toBeUndefined();
  });

  it("missing accountIds/accountTypes parse to undefined, not an empty array", () => {
    const r = reportDataQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.accountIds).toBeUndefined();
    expect(r.data!.accountTypes).toBeUndefined();
  });
});

describe("incomeStatementQuery", () => {
  it("accepts both startDate and endDate present", () => {
    const r = incomeStatementQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
  });

  it("accepts both startDate and endDate absent", () => {
    const r = incomeStatementQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.startDate).toBeUndefined();
    expect(r.data!.endDate).toBeUndefined();
  });

  it("rejects startDate present without endDate, with the ported message", () => {
    const r = incomeStatementQuery.safeParse({ startDate: "2025-01-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Both startDate and endDate are required");
  });

  it("rejects endDate present without startDate, with the ported message", () => {
    const r = incomeStatementQuery.safeParse({ endDate: "2025-01-31" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Both startDate and endDate are required");
  });

  it("a missing includeInactive parses to undefined, not a coerced boolean", () => {
    const r = incomeStatementQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.includeInactive).toBeUndefined();
  });

  it("carries includeInactive through as a raw string, not a boolean", () => {
    const r = incomeStatementQuery.safeParse({ includeInactive: "true" });
    expect(r.success).toBe(true);
    expect(r.data!.includeInactive).toBe("true");
  });
});

describe("realizedGainsQuery", () => {
  it("accepts both startDate and endDate present", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
  });

  it("accepts both startDate and endDate absent", () => {
    const r = realizedGainsQuery.safeParse({});
    expect(r.success).toBe(true);
  });

  it("rejects startDate present without endDate, with the ported message", () => {
    const r = realizedGainsQuery.safeParse({ startDate: "2025-01-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Both startDate and endDate are required");
  });

  it("rejects endDate present without startDate, with the ported message", () => {
    const r = realizedGainsQuery.safeParse({ endDate: "2025-01-31" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Both startDate and endDate are required");
  });

  it("a missing accountId parses to undefined, not a coerced 0", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBeUndefined();
  });

  it("accepts a positive integer accountId string", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      accountId: "5",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe("5");
  });

  it("rejects a non-numeric accountId", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      accountId: "abc",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects a non-positive accountId (0)", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      accountId: "0",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects a fractional accountId", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      accountId: "5.5",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("reports the date-requirement message ahead of an invalid accountId, matching the route's early return", () => {
    const r = realizedGainsQuery.safeParse({
      startDate: "2025-01-01",
      accountId: "abc",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Both startDate and endDate are required");
  });
});
