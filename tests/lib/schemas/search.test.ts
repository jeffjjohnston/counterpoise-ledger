import { describe, it, expect } from "vitest";
import { searchQuery } from "@/lib/schemas/search";

describe("searchQuery", () => {
  it("accepts an empty object, defaulting q to an empty string", () => {
    const r = searchQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ q: "" });
  });

  it("accepts an explicit blank q and keeps it a blank string, not a validation error", () => {
    // This is the whole point of the schema: the route's caller must be able
    // to pass an empty q through and get 200 + empty results, matching
    // searchBook()'s own "blank query -> empty buckets" behavior
    // (lib/search.ts) and tests/api/search.test.ts's existing coverage of it.
    const r = searchQuery.safeParse({ q: "" });
    expect(r.success).toBe(true);
    expect(r.data!.q).toBe("");
  });

  it("trims a query with surrounding whitespace", () => {
    const r = searchQuery.safeParse({ q: "  groceries  " });
    expect(r.success).toBe(true);
    expect(r.data!.q).toBe("groceries");
  });

  it("collapses a whitespace-only query to an empty string", () => {
    const r = searchQuery.safeParse({ q: "   " });
    expect(r.success).toBe(true);
    expect(r.data!.q).toBe("");
  });

  it("accepts a full query with valid startDate/endDate", () => {
    const r = searchQuery.safeParse({
      q: "rent",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ q: "rent", startDate: "2025-01-01", endDate: "2025-01-31" });
  });

  it("leaves startDate/endDate undefined when omitted, not coerced to a real value", () => {
    const r = searchQuery.safeParse({ q: "test" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ q: "test" });
  });

  it("rejects a malformed startDate with zod's default ISO date message", () => {
    const r = searchQuery.safeParse({ startDate: "not-a-date" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid ISO date");
  });

  it("rejects a malformed endDate with zod's default ISO date message", () => {
    const r = searchQuery.safeParse({ endDate: "01/31/2025" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid ISO date");
  });

  it("rejects a startDate with an out-of-range month/day", () => {
    const r = searchQuery.safeParse({ startDate: "2025-13-45" });
    expect(r.success).toBe(false);
  });
});
