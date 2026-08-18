import { describe, it, expect } from "vitest";
import {
  createTokenSchema,
  updateTokenSchema,
  assignAccountsSchema,
  reconcileSchema,
  pendingTransactionsQuery,
  reconcileListQuery,
} from "@/lib/schemas/sync";

describe("createTokenSchema", () => {
  it("accepts a valid token", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: "Chase",
      itemId: "item-123",
      accessToken: "access-sandbox-123",
    });
    expect(r.success).toBe(true);
  });

  it("trims whitespace, matching the route's prior normalizeString()", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: "  Chase  ",
      itemId: "  item-123  ",
      accessToken: "  access-123  ",
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      financialInstitution: "Chase",
      itemId: "item-123",
      accessToken: "access-123",
    });
  });

  it("rejects a missing financialInstitution with the ported combined message", () => {
    const r = createTokenSchema.safeParse({
      itemId: "item-123",
      accessToken: "access-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });

  it("rejects an empty financialInstitution with the ported combined message", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: "",
      itemId: "item-123",
      accessToken: "access-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });

  it("rejects a whitespace-only itemId (empty after trim)", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: "Chase",
      itemId: "   ",
      accessToken: "access-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });

  it("rejects a missing accessToken with the ported combined message", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: "Chase",
      itemId: "item-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });

  it("rejects a non-string field with the ported combined message", () => {
    const r = createTokenSchema.safeParse({
      financialInstitution: 123,
      itemId: "item-123",
      accessToken: "access-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route reads each field via `normalizeString(body.field)`
    // — property access, not destructuring. An array/string/number/boolean
    // auto-boxes every access to undefined without throwing (normalizeString
    // turns that into "", same as a body simply missing the keys) — only a
    // literal `null` body threw. All five had — or, for null, now gain — the
    // same combined message at 400.
    const r = createTokenSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });
});

describe("updateTokenSchema", () => {
  it("accepts a valid update with all fields", () => {
    const r = updateTokenSchema.safeParse({
      financialInstitution: "New Bank",
      itemId: "item-new",
      accessToken: "new-access-token",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing financialInstitution with the ported combined message", () => {
    const r = updateTokenSchema.safeParse({ itemId: "item-1" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution and itemId are required"
    );
  });

  it("rejects an empty itemId with the ported combined message", () => {
    const r = updateTokenSchema.safeParse({
      financialInstitution: "Bank",
      itemId: "",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution and itemId are required"
    );
  });

  it("accepts an empty-string accessToken (means: leave it unchanged)", () => {
    // tests/api/sync-tokens.test.ts's "rejects duplicate item ids on update"
    // sends exactly this and must not error on shape.
    const r = updateTokenSchema.safeParse({
      financialInstitution: "A",
      itemId: "item-b",
      accessToken: "",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accessToken).toBeUndefined();
  });

  it("accepts an omitted accessToken", () => {
    const r = updateTokenSchema.safeParse({
      financialInstitution: "A",
      itemId: "item-a",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accessToken).toBeUndefined();
  });

  it("accepts a non-string accessToken, silently ignoring it like normalizeString() did", () => {
    const r = updateTokenSchema.safeParse({
      financialInstitution: "A",
      itemId: "item-a",
      accessToken: 12345,
    });
    expect(r.success).toBe(true);
    expect(r.data!.accessToken).toBeUndefined();
  });

  it("trims a real accessToken value", () => {
    const r = updateTokenSchema.safeParse({
      financialInstitution: "A",
      itemId: "item-a",
      accessToken: "  tok-123  ",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accessToken).toBe("tok-123");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // Same reasoning as createTokenSchema's equivalent test above: the
    // original route reads each field via `normalizeString(body.field)`
    // property access, so a non-object body auto-boxes to undefined -> ""
    // and reports this exact combined message at 400 (only a literal `null`
    // body threw, pre-schema).
    const r = updateTokenSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "financialInstitution and itemId are required"
    );
  });
});

describe("assignAccountsSchema", () => {
  it("accepts a valid assignment list", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1", counterpoiseAccountId: 5 }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a null counterpoiseAccountId (unassigning)", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1", counterpoiseAccountId: null }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty assignments array", () => {
    const r = assignAccountsSchema.safeParse({ assignments: [] });
    expect(r.success).toBe(true);
  });

  it("rejects a non-array assignments with the ported message", () => {
    const r = assignAccountsSchema.safeParse({ assignments: "not-an-array" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("assignments must be an array");
  });

  it("rejects a missing assignments key with the ported message", () => {
    const r = assignAccountsSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("assignments must be an array");
  });

  it("rejects a missing plaidAccountId with the ported message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ counterpoiseAccountId: 5 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Each assignment must include plaidAccountId"
    );
  });

  it("rejects a whitespace-only plaidAccountId with the ported message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "   ", counterpoiseAccountId: null }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Each assignment must include plaidAccountId"
    );
  });

  it("trims a padded plaidAccountId", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "  plaid-1  ", counterpoiseAccountId: null }],
    });
    expect(r.success).toBe(true);
    expect(r.data!.assignments[0].plaidAccountId).toBe("plaid-1");
  });

  it("rejects a missing counterpoiseAccountId key with the ported message", () => {
    // Not `.optional()`: the original guard fails Number.isInteger(undefined)
    // for a key that's absent entirely, same as any other invalid value.
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1" }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "counterpoiseAccountId must be a positive integer or null"
    );
  });

  it("rejects counterpoiseAccountId 0 with the ported message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1", counterpoiseAccountId: 0 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "counterpoiseAccountId must be a positive integer or null"
    );
  });

  it("rejects a negative counterpoiseAccountId with the ported message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1", counterpoiseAccountId: -5 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "counterpoiseAccountId must be a positive integer or null"
    );
  });

  it("rejects a non-integer counterpoiseAccountId with the ported message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [{ plaidAccountId: "plaid-1", counterpoiseAccountId: 1.5 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "counterpoiseAccountId must be a positive integer or null"
    );
  });

  it("rejects a duplicate plaidAccountId with the ported array-level message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [
        { plaidAccountId: "plaid-1", counterpoiseAccountId: null },
        { plaidAccountId: "plaid-1", counterpoiseAccountId: null },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Duplicate plaidAccountId in assignments");
  });

  it("rejects a duplicate counterpoiseAccountId with the ported array-level message", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [
        { plaidAccountId: "plaid-1", counterpoiseAccountId: 5 },
        { plaidAccountId: "plaid-2", counterpoiseAccountId: 5 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "A Counterpoise account cannot be assigned to more than one Plaid account"
    );
  });

  it("allows multiple assignments with counterpoiseAccountId: null (null is never a duplicate)", () => {
    const r = assignAccountsSchema.safeParse({
      assignments: [
        { plaidAccountId: "plaid-1", counterpoiseAccountId: null },
        { plaidAccountId: "plaid-2", counterpoiseAccountId: null },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("reports the plaidAccountId duplicate before the counterpoiseAccountId duplicate when both are present", () => {
    // Matches the original route's order: plaidAccountId duplicates were
    // detected in a loop before any DB read; counterpoiseAccountId
    // duplicates were detected later.
    const r = assignAccountsSchema.safeParse({
      assignments: [
        { plaidAccountId: "plaid-1", counterpoiseAccountId: 5 },
        { plaidAccountId: "plaid-1", counterpoiseAccountId: 5 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Duplicate plaidAccountId in assignments");
  });

  it("reports the ported message for a null element, not zod's raw type-check text", () => {
    // Fix round 1: `assignment?.plaidAccountId` optional-chained safely
    // around a null element in the original code, landing on the same
    // "must include plaidAccountId" message a genuine object missing the
    // field gets. Before the accountAssignmentSchema-level `{ error }` was
    // added, this produced zod's default "Invalid input: expected object,
    // received null" instead.
    const r = assignAccountsSchema.safeParse({ assignments: [null] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Each assignment must include plaidAccountId");
  });

  it("reports the ported message for a non-object element (string)", () => {
    const r = assignAccountsSchema.safeParse({ assignments: ["oops"] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Each assignment must include plaidAccountId");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route reads `body.assignments` via property access — for
    // a non-object body, that auto-boxes to undefined and
    // `!Array.isArray(undefined)` reports this exact message at 400 (only a
    // literal `null` body threw, pre-schema). This corrects an earlier
    // (wrong) ruling during this plan that no override was needed here
    // because a null body 500'd — true for literal `null` only, not for
    // `[]`/`"abc"`/`5`/`true`, which auto-box instead of throwing.
    const r = assignAccountsSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("assignments must be an array");
  });
});

describe("reconcileSchema", () => {
  it("accepts a valid match action", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "match",
      transactionId: 42,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid match_update_amount action", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "match_update_amount",
      transactionId: 42,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid create action with payeeName", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "create",
      counterAccountId: 7,
      payeeName: "Trader Joe's",
    });
    expect(r.success).toBe(true);
  });

  it("accepts create without payeeName (route falls back to Plaid's own name)", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "create",
      counterAccountId: 7,
    });
    expect(r.success).toBe(true);
  });

  it("accepts ignore/keep_local/unlink with only reconciliationId", () => {
    for (const action of ["ignore", "keep_local", "unlink"]) {
      const r = reconcileSchema.safeParse({ reconciliationId: 1, action });
      expect(r.success).toBe(true);
    }
  });

  it("rejects a missing reconciliationId with the ported message", () => {
    const r = reconcileSchema.safeParse({ action: "ignore" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });

  it("rejects a non-integer reconciliationId with the ported message", () => {
    const r = reconcileSchema.safeParse({ reconciliationId: 1.5, action: "ignore" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });

  it("reports reconciliationId's issue first even when action is also invalid", () => {
    const r = reconcileSchema.safeParse({ reconciliationId: "x", action: "bogus" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });

  it("rejects an unknown action with the ported message", () => {
    const r = reconcileSchema.safeParse({ reconciliationId: 1, action: "bogus" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid action");
  });

  it("rejects match with a missing transactionId, with the ported action-specific message", () => {
    const r = reconcileSchema.safeParse({ reconciliationId: 1, action: "match" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("transactionId is required for match");
  });

  it("rejects match with a non-numeric transactionId, same message", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "match",
      transactionId: "abc",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("transactionId is required for match");
  });

  it("accepts a negative transactionId for match (no positivity check in the original guard)", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "match",
      transactionId: -3,
    });
    expect(r.success).toBe(true);
  });

  it("rejects match_update_amount with a missing transactionId, with its own ported message", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "match_update_amount",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "transactionId is required for match_update_amount"
    );
  });

  it("rejects create with a missing counterAccountId, with the ported message", () => {
    const r = reconcileSchema.safeParse({ reconciliationId: 1, action: "create" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("counterAccountId is required for create");
  });

  it("rejects create with counterAccountId 0, same message (positivity is required here)", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "create",
      counterAccountId: 0,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("counterAccountId is required for create");
  });

  it("rejects create with a negative counterAccountId, same message", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "create",
      counterAccountId: -1,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("counterAccountId is required for create");
  });

  it("does not validate payeeName's type (the original guard silently ignored non-strings)", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "create",
      counterAccountId: 7,
      payeeName: 12345,
    });
    expect(r.success).toBe(true);
  });

  it("ignores an extraneous transactionId on ignore/keep_local/unlink (never read for those actions)", () => {
    const r = reconcileSchema.safeParse({
      reconciliationId: 1,
      action: "ignore",
      transactionId: "not-a-number",
    });
    expect(r.success).toBe(true);
  });

  it("reports the ported message for a null body, not zod's raw type-check text", () => {
    // Fix round 1: the original guard's `!body || typeof body !== "object"`
    // treated a null (or non-object) body the same as one simply missing
    // reconciliationId. Before the top-level `{ error }` was added, this
    // produced zod's default "Invalid input: expected object, received
    // null" instead.
    const r = reconcileSchema.safeParse(null);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });

  it("reports the ported message for a non-object body (string)", () => {
    const r = reconcileSchema.safeParse("oops");
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });

  it("reports the ported message for a non-object body (array)", () => {
    const r = reconcileSchema.safeParse([]);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("reconciliationId is required");
  });
});

describe("pendingTransactionsQuery", () => {
  it("accepts an absent accountId", () => {
    const r = pendingTransactionsQuery.safeParse({ accountId: undefined });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBeUndefined();
  });

  it("accepts a valid numeric accountId", () => {
    const r = pendingTransactionsQuery.safeParse({ accountId: "5" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(5);
  });

  it("rejects a non-numeric accountId with the ported message", () => {
    const r = pendingTransactionsQuery.safeParse({ accountId: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("accepts a negative accountId (the original guard only checked finiteness)", () => {
    const r = pendingTransactionsQuery.safeParse({ accountId: "-5" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(-5);
  });

  it("accepts a zero accountId", () => {
    const r = pendingTransactionsQuery.safeParse({ accountId: "0" });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(0);
  });

  it("rejects a fractional accountId with the ported message (fix round 1: added .int())", () => {
    // parseInt("5.5", 10) in the original route always truncated to 5 — it
    // can never produce a fractional value. z.coerce.number() alone can
    // ("5.5" -> 5.5), which would reach `eq(accounts.id, 5.5)` against an
    // integer column. .int() restores the "whole number or rejected"
    // guarantee.
    const r = pendingTransactionsQuery.safeParse({ accountId: "5.5" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });
});

describe("reconcileListQuery", () => {
  it("defaults limit to 25 and offset to 0 when both are absent", () => {
    const r = reconcileListQuery.safeParse({ limit: undefined, offset: undefined });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 25, offset: 0 });
  });

  it("accepts valid limit and offset", () => {
    const r = reconcileListQuery.safeParse({ limit: "10", offset: "20" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ limit: 10, offset: 20 });
  });

  it("falls back to the default limit for a non-numeric value, never 400s", () => {
    const r = reconcileListQuery.safeParse({ limit: "abc" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(25);
  });

  it("falls back to the default limit for zero or negative, never 400s", () => {
    for (const invalid of ["0", "-5"]) {
      const r = reconcileListQuery.safeParse({ limit: invalid });
      expect(r.success).toBe(true);
      expect(r.data!.limit).toBe(25);
    }
  });

  it("falls back to the default offset for a non-numeric or negative value, never 400s", () => {
    for (const invalid of ["abc", "-1"]) {
      const r = reconcileListQuery.safeParse({ offset: invalid });
      expect(r.success).toBe(true);
      expect(r.data!.offset).toBe(0);
    }
  });

  it("accepts an offset of 0 as a real value, not just the fallback", () => {
    const r = reconcileListQuery.safeParse({ offset: "0" });
    expect(r.success).toBe(true);
    expect(r.data!.offset).toBe(0);
  });

  it("has no upper-bound clamp on limit, unlike securities.ts's limitParam", () => {
    const r = reconcileListQuery.safeParse({ limit: "5000" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(5000);
  });

  it("falls back to the default limit for a fractional value rather than truncating", () => {
    // Documents the one caveat noted in lib/schemas/sync.ts: the original
    // Number.parseInt("1.5", 10) truncated to 1 (no fallback); z.coerce
    // .number() parses "1.5" -> 1.5, which fails .int() and falls back to
    // the default instead. Still never 400s.
    const r = reconcileListQuery.safeParse({ limit: "1.5" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(25);
  });
});
