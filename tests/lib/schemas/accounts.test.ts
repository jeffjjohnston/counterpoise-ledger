import { describe, it, expect } from "vitest";
import {
  createAccountSchema,
  updateAccountSchema,
  listAccountsQuery,
} from "@/lib/schemas/accounts";

describe("createAccountSchema", () => {
  it("accepts a minimal valid account", () => {
    const r = createAccountSchema.safeParse({ name: "Checking", type: "asset" });
    expect(r.success).toBe(true);
  });

  it("accepts a full valid account", () => {
    const r = createAccountSchema.safeParse({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
      parentId: 3,
    });
    expect(r.success).toBe(true);
  });

  it("accepts null subtype and parentId", () => {
    const r = createAccountSchema.safeParse({
      name: "Checking",
      type: "asset",
      subtype: null,
      parentId: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown type with the ported message", () => {
    const r = createAccountSchema.safeParse({ name: "Checking", type: "banana" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid account type");
  });

  it("rejects a missing type with the ported message", () => {
    const r = createAccountSchema.safeParse({ name: "Checking" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid account type");
  });

  it("rejects an empty name with the ported message", () => {
    const r = createAccountSchema.safeParse({ name: "", type: "asset" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name and type are required");
  });

  it("rejects a missing name with the ported message", () => {
    const r = createAccountSchema.safeParse({ type: "asset" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name and type are required");
  });

  it("rejects an unknown subtype with a dedicated message", () => {
    const r = createAccountSchema.safeParse({
      name: "Checking",
      type: "asset",
      subtype: "banana",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid account subtype");
  });

  it("rejects a non-positive parentId", () => {
    const r = createAccountSchema.safeParse({ name: "Checking", type: "asset", parentId: 0 });
    expect(r.success).toBe(false);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ name, type, ... }` straight off the
    // parsed body. An array/string/number/boolean auto-boxes without
    // throwing (name/type come out undefined, same as a body simply missing
    // the keys) — only a literal `null` body threw. All five had — or, for
    // null, now gain — the same "required" message at 400.
    const r = createAccountSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name and type are required");
  });
});

describe("updateAccountSchema", () => {
  it("accepts an empty update (no fields changed)", () => {
    const r = updateAccountSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a partial update", () => {
    const r = updateAccountSchema.safeParse({ name: "New Name" });
    expect(r.success).toBe(true);
  });

  it("accepts clearing parentId and subtype with null", () => {
    const r = updateAccountSchema.safeParse({ parentId: null, subtype: null });
    expect(r.success).toBe(true);
  });

  it("silently drops an unexpected type field", () => {
    // An account's type cannot be changed after creation; the route never
    // reads `type` from a PUT body, so the schema does not model it either.
    // zod's default behavior for an object schema is to strip unknown keys
    // rather than reject them, so this succeeds — it isn't rejected input.
    const r = updateAccountSchema.safeParse({ name: "Checking", type: "liability" });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("type");
  });

  it("rejects an unknown subtype with the same message as create", () => {
    const r = updateAccountSchema.safeParse({ subtype: "banana" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid account subtype");
  });

  it("rejects a non-positive parentId", () => {
    const r = updateAccountSchema.safeParse({ parentId: -1 });
    expect(r.success).toBe(false);
  });

  it("rejects a non-boolean isActive", () => {
    const r = updateAccountSchema.safeParse({ isActive: "false" });
    expect(r.success).toBe(false);
  });
});

describe("listAccountsQuery", () => {
  it("accepts an empty query", () => {
    const r = listAccountsQuery.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts the current GET query params", () => {
    const r = listAccountsQuery.safeParse({
      type: "asset",
      includeInactive: "true",
      asOfDate: "2025-03-01",
    });
    expect(r.success).toBe(true);
  });

  it("a missing optional param parses to undefined, not a coerced value", () => {
    // The route maps URLSearchParams.get()'s `null` to `undefined` before
    // calling safeParse — this pins that an absent field comes back as
    // `undefined` here rather than being silently coerced into a real
    // filter value (e.g. a coerced date or number defaulting to 0).
    const r = listAccountsQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      type: undefined,
      includeInactive: undefined,
      asOfDate: undefined,
    });
  });

  it("rejects an unknown type", () => {
    const r = listAccountsQuery.safeParse({ type: "banana" });
    expect(r.success).toBe(false);
  });

  it("accepts any string for includeInactive (the route enforces === 'true')", () => {
    const r = listAccountsQuery.safeParse({ includeInactive: "yes" });
    expect(r.success).toBe(true);
    expect(r.data!.includeInactive).toBe("yes");
  });

  it("rejects an asOfDate with an out-of-range month/day", () => {
    const r = listAccountsQuery.safeParse({ asOfDate: "2026-13-45" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-ISO asOfDate format", () => {
    const r = listAccountsQuery.safeParse({ asOfDate: "03/01/2025" });
    expect(r.success).toBe(false);
  });
});
