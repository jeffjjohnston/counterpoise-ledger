import { describe, it, expect } from "vitest";
import {
  createRuleSchema,
  updateRuleSchema,
  processRulesSchema,
  projectedQuery,
  recurringTransactionsQuery,
} from "@/lib/schemas/recurring";

const validTemplateSplits = [
  { accountId: 1, amount: 15000 },
  { accountId: 2, amount: -15000 },
];

describe("createRuleSchema", () => {
  it("accepts a minimal valid rule", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a full valid rule", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      interval: 2,
      daysOfWeek: [1, 3],
      weekOfMonth: "last",
      daysOfMonth: [15],
      startDate: "2026-02-01",
      endDate: "2026-12-31",
      templateDescription: "Monthly rent",
      templateSplits: validTemplateSplits,
      autoCreateDaysBefore: 5,
      payeeId: 7,
      payeeName: "Landlord",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing name with the ported combined message", () => {
    const r = createRuleSchema.safeParse({
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Name, frequency, startDate, and templateSplits are required"
    );
  });

  it("rejects an empty name with the ported combined message", () => {
    const r = createRuleSchema.safeParse({
      name: "",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Name, frequency, startDate, and templateSplits are required"
    );
  });

  it("rejects a missing frequency with a dedicated message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid frequency");
  });

  it("rejects an unknown frequency value", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "biweekly",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid frequency");
  });

  it("rejects a missing startDate with its own format message, not the combined one", () => {
    // Once startDate has its own dedicated validator (below), its absence is
    // reported through that validator rather than the 4-field combined
    // message — same trade-off accounts.ts documents for its `type` field.
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate must be in YYYY-MM-DD format");
  });

  it("rejects a malformed startDate with the ported format message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-2-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate must be in YYYY-MM-DD format");
  });

  it("rejects an out-of-range startDate", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-13-45",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate must be in YYYY-MM-DD format");
  });

  it("rejects a malformed endDate with the ported format message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      endDate: "2026-2-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("endDate must be in YYYY-MM-DD format");
  });

  it("accepts a null endDate (no end date)", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      endDate: null,
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(true);
    expect(r.data!.endDate).toBeNull();
  });

  it("accepts an empty-string endDate, matching the create form's `endDate || null`", () => {
    // The recurring-rule create form always sends `endDate: endDate || null`
    // when its end-date input is empty. The original POST guard
    // (`endDate && !isValidDateString(endDate)`) also treated "" as falsy
    // and skipped validation, normalizing it to null on insert.
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      endDate: "",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(true);
    expect(r.data!.endDate).toBeNull();
  });

  it("rejects an omitted templateSplits key with its own shape message, not the combined one", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("rejects fewer than 2 template splits with the ported message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: [{ accountId: 1, amount: 15000 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("rejects a non-array templateSplits with the ported message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: "not-an-array",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("rejects a template split with a non-integer accountId, same message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: [
        { accountId: 1.5, amount: 15000 },
        { accountId: 2, amount: -15000 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("rejects a template split with a non-finite amount, same message", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: [
        { accountId: 1, amount: Infinity },
        { accountId: 2, amount: -15000 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("accepts a template split amount that overflows a Postgres integer column", () => {
    // tests/api/recurring.test.ts's "leaves no rule behind..." case relies on
    // this passing shape validation (and the sum-to-zero business check) so
    // the failure happens at the database INSERT instead.
    const r = createRuleSchema.safeParse({
      name: "Broken Rule",
      frequency: "monthly",
      startDate: "2026-05-01",
      templateSplits: [
        { accountId: 1, amount: -3_000_000_000 },
        { accountId: 2, amount: 3_000_000_000 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an out-of-range autoCreateDaysBefore with the ported message", () => {
    for (const invalid of [-1, 31, 1.5]) {
      const r = createRuleSchema.safeParse({
        name: "Rent",
        frequency: "monthly",
        startDate: "2026-02-01",
        templateSplits: validTemplateSplits,
        autoCreateDaysBefore: invalid,
      });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0].message).toBe(
        "autoCreateDaysBefore must be an integer between 0 and 30"
      );
    }
  });

  it("accepts an omitted autoCreateDaysBefore (route defaults it to 0)", () => {
    const r = createRuleSchema.safeParse({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      templateSplits: validTemplateSplits,
    });
    expect(r.success).toBe(true);
    expect(r.data!.autoCreateDaysBefore).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ name, frequency, ... }` straight
    // off the parsed body. An array/string/number/boolean auto-boxes without
    // throwing (name/frequency/startDate/templateSplits come out undefined,
    // same as a body simply missing the keys) — only a literal `null` body
    // threw. All five had — or, for null, now gain — the same combined
    // "required" message at 400.
    const r = createRuleSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Name, frequency, startDate, and templateSplits are required"
    );
  });
});

describe("updateRuleSchema", () => {
  it("accepts an empty update (no fields changed)", () => {
    const r = updateRuleSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a partial update", () => {
    const r = updateRuleSchema.safeParse({ name: "New Name" });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed startDate with the ported format message", () => {
    const r = updateRuleSchema.safeParse({ startDate: "2026-2-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate must be in YYYY-MM-DD format");
  });

  it("rejects a null startDate (unlike endDate, PUT never treats it as absent)", () => {
    const r = updateRuleSchema.safeParse({ startDate: null });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate must be in YYYY-MM-DD format");
  });

  it("rejects a malformed endDate with the ported format message", () => {
    const r = updateRuleSchema.safeParse({ endDate: "2026-2-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("endDate must be in YYYY-MM-DD format");
  });

  it("rejects an empty-string endDate (PUT does not treat it as absent, unlike POST)", () => {
    const r = updateRuleSchema.safeParse({ endDate: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("endDate must be in YYYY-MM-DD format");
  });

  it("accepts a null endDate (explicit clear)", () => {
    const r = updateRuleSchema.safeParse({ endDate: null });
    expect(r.success).toBe(true);
    expect(r.data!.endDate).toBeNull();
  });

  it("rejects a malformed nextDate with the ported format message", () => {
    const r = updateRuleSchema.safeParse({ nextDate: "2026-2-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("nextDate must be in YYYY-MM-DD format");
  });

  it("accepts a null nextDate", () => {
    const r = updateRuleSchema.safeParse({ nextDate: null });
    expect(r.success).toBe(true);
  });

  it("rejects fewer than 2 template splits with the ported message", () => {
    const r = updateRuleSchema.safeParse({
      templateSplits: [{ accountId: 1, amount: 15000 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "templateSplits must be an array of at least 2 valid splits"
    );
  });

  it("accepts valid template splits", () => {
    const r = updateRuleSchema.safeParse({ templateSplits: validTemplateSplits });
    expect(r.success).toBe(true);
  });

  it("rejects an out-of-range autoCreateDaysBefore with the ported message", () => {
    for (const invalid of [-1, 31, 1.5]) {
      const r = updateRuleSchema.safeParse({ autoCreateDaysBefore: invalid });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0].message).toBe(
        "autoCreateDaysBefore must be an integer between 0 and 30"
      );
    }
  });

  it("rejects an unknown frequency value", () => {
    const r = updateRuleSchema.safeParse({ frequency: "biweekly" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid frequency");
  });

  it("accepts an empty name (PUT never guarded this, unlike POST)", () => {
    const r = updateRuleSchema.safeParse({ name: "" });
    expect(r.success).toBe(true);
  });

  it("rejects a non-boolean isActive", () => {
    const r = updateRuleSchema.safeParse({ isActive: "true" });
    expect(r.success).toBe(false);
  });
});

describe("processRulesSchema", () => {
  it("accepts an empty body", () => {
    const r = processRulesSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a ruleId", () => {
    const r = processRulesSchema.safeParse({ ruleId: 5 });
    expect(r.success).toBe(true);
  });

  it("accepts processAll", () => {
    const r = processRulesSchema.safeParse({ processAll: true });
    expect(r.success).toBe(true);
  });

  it("accepts ruleId 0 (the route's own truthy check already treats it as absent)", () => {
    const r = processRulesSchema.safeParse({ ruleId: 0 });
    expect(r.success).toBe(true);
  });

  it("rejects a non-numeric ruleId", () => {
    const r = processRulesSchema.safeParse({ ruleId: "5" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-boolean processAll", () => {
    const r = processRulesSchema.safeParse({ processAll: "true" });
    expect(r.success).toBe(false);
  });
});

describe("projectedQuery", () => {
  it("accepts an empty query", () => {
    const r = projectedQuery.safeParse({});
    expect(r.success).toBe(true);
  });

  it("a missing param parses to undefined, not a coerced value", () => {
    const r = projectedQuery.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ startDate: undefined, endDate: undefined, accountId: undefined });
  });

  it("accepts valid startDate, endDate, and accountId", () => {
    const r = projectedQuery.safeParse({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      accountId: "5",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accountId).toBe(5);
  });

  it("rejects a malformed startDate", () => {
    const r = projectedQuery.safeParse({ startDate: "2026-1-1" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-numeric accountId", () => {
    const r = projectedQuery.safeParse({ accountId: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects a non-positive accountId", () => {
    const r = projectedQuery.safeParse({ accountId: "0" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });
});

describe("recurringTransactionsQuery", () => {
  it("accepts both dates present", () => {
    const r = recurringTransactionsQuery.safeParse({
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing startDate with the ported message", () => {
    const r = recurringTransactionsQuery.safeParse({ endDate: "2025-01-31" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate and endDate are required");
  });

  it("rejects a missing endDate with the ported message", () => {
    const r = recurringTransactionsQuery.safeParse({ startDate: "2025-01-01" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("startDate and endDate are required");
  });

  it("does not validate date format (the original guard only checked presence)", () => {
    const r = recurringTransactionsQuery.safeParse({
      startDate: "not-a-date",
      endDate: "also-not-a-date",
    });
    expect(r.success).toBe(true);
  });
});
