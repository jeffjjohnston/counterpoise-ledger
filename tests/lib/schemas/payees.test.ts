import { describe, it, expect } from "vitest";
import { createPayeeSchema, listPayeesQuery } from "@/lib/schemas/payees";

describe("createPayeeSchema", () => {
  it("accepts a valid name", () => {
    const r = createPayeeSchema.safeParse({ name: "Blue Bottle" });
    expect(r.success).toBe(true);
    expect(r.data!.name).toBe("Blue Bottle");
  });

  it("trims surrounding whitespace", () => {
    const r = createPayeeSchema.safeParse({ name: "  Blue Bottle  " });
    expect(r.success).toBe(true);
    expect(r.data!.name).toBe("Blue Bottle");
  });

  it("rejects a missing name with the ported message", () => {
    const r = createPayeeSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects a non-string name with the ported message", () => {
    const r = createPayeeSchema.safeParse({ name: 123 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects an empty string with the ported message", () => {
    const r = createPayeeSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects a whitespace-only name (empty after trim) with the ported message", () => {
    const r = createPayeeSchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ name } = body` straight off the
    // parsed body. An array/string/number/boolean auto-boxes without
    // throwing (name comes out undefined, same as a body simply missing the
    // key) — only a literal `null` body threw. All five had — or, for null,
    // now gain — the same "Name is required" message at 400.
    const r = createPayeeSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });
});

describe("listPayeesQuery", () => {
  it("accepts an empty query", () => {
    const r = listPayeesQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ search: undefined, limit: undefined });
  });

  it("a missing limit parses to undefined, not a coerced 0", () => {
    const r = listPayeesQuery.safeParse({ search: "foo" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBeUndefined();
  });

  it("accepts a valid limit", () => {
    const r = listPayeesQuery.safeParse({ limit: "10" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(10);
  });

  it("falls back to undefined (no limit) for a non-numeric limit, never 400s", () => {
    const r = listPayeesQuery.safeParse({ limit: "abc" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBeUndefined();
  });

  it("falls back to undefined (no limit) for a negative limit, never 400s", () => {
    const r = listPayeesQuery.safeParse({ limit: "-5" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBeUndefined();
  });

  it("falls back to undefined (no limit) for a fractional limit, never 400s", () => {
    const r = listPayeesQuery.safeParse({ limit: "5.5" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBeUndefined();
  });

  it("carries search through unchanged (normalization stays in the route)", () => {
    const r = listPayeesQuery.safeParse({ search: "  Blue   Bottle  " });
    expect(r.success).toBe(true);
    expect(r.data!.search).toBe("  Blue   Bottle  ");
  });
});
