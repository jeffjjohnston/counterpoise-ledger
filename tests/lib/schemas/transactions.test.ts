import { describe, it, expect } from "vitest";
import {
  createTransactionBodySchema,
  investmentSplitSchema,
  listTransactionsQuery,
  splitSchema,
  updateTransactionBodySchema,
} from "@/lib/schemas/transactions";

// A minimal balanced payload the date tests can vary one field of.
const validCreateBody = {
  date: "2026-03-15",
  splits: [
    { accountId: 1, amount: -1000 },
    { accountId: 2, amount: 1000 },
  ],
};

describe("splitSchema", () => {
  it("accepts a split", () => {
    expect(splitSchema.safeParse({ accountId: 1, amount: -1000 }).success).toBe(true);
  });

  it("accepts a zero amount (stock splits post two zero-amount legs)", () => {
    expect(splitSchema.safeParse({ accountId: 1, amount: 0 }).success).toBe(true);
  });

  it("rejects a non-positive accountId", () => {
    // The investment entry form falls back to `accountId: 0` when an account
    // is unset; that used to reach Postgres and fail the FK with a 500.
    expect(splitSchema.safeParse({ accountId: 0, amount: 100 }).success).toBe(false);
  });

  it("rejects a fractional amount", () => {
    expect(splitSchema.safeParse({ accountId: 1, amount: 10.5 }).success).toBe(false);
  });

  it("rejects a missing amount", () => {
    expect(splitSchema.safeParse({ accountId: 1 }).success).toBe(false);
  });
});

describe("investmentSplitSchema", () => {
  it("accepts a buy", () => {
    const r = investmentSplitSchema.safeParse({
      securityId: 1,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 5_000_000,
      feesCents: 0,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a stock split with a ratio and zero shares/price", () => {
    const r = investmentSplitSchema.safeParse({
      securityId: 1,
      action: "split",
      sharesMicros: 0,
      priceMicros: 0,
      feesCents: 0,
      splitNumerator: 2,
      splitDenominator: 1,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown action", () => {
    // investment_splits.action is a plain Postgres `text` column — Drizzle's
    // `{ enum: [...] }` is a TypeScript-only annotation and there is no CHECK
    // constraint anywhere in the migration history. Before this schema, an
    // action of "banana" was silently persisted; this is the only runtime
    // enforcement the value has.
    const r = investmentSplitSchema.safeParse({
      securityId: 1,
      action: "banana",
      sharesMicros: 0,
      priceMicros: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative shares", () => {
    // sharesMicros is always stored positive; direction comes from `action`.
    const r = investmentSplitSchema.safeParse({
      securityId: 1,
      action: "sell",
      sharesMicros: -10_000_000,
      priceMicros: 5_000_000,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero split denominator", () => {
    const r = investmentSplitSchema.safeParse({
      securityId: 1,
      action: "split",
      sharesMicros: 0,
      priceMicros: 0,
      splitNumerator: 2,
      splitDenominator: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe("createTransactionBodySchema", () => {
  it("accepts a minimal balanced transaction", () => {
    expect(createTransactionBodySchema.safeParse(validCreateBody).success).toBe(true);
  });

  it("accepts every field the transactions page sends", () => {
    const r = createTransactionBodySchema.safeParse({
      ...validCreateBody,
      description: "Weekly shopping",
      notes: "note",
      payeeName: "Whole Foods",
      checkNumber: "1001",
      isFloating: true,
      isReconciled: false,
      investmentSplits: [
        {
          securityId: 1,
          action: "buy",
          sharesMicros: 10_000_000,
          priceMicros: 5_000_000,
          feesCents: 0,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty description and payeeName (the form sends trimmed strings)", () => {
    const r = createTransactionBodySchema.safeParse({
      ...validCreateBody,
      description: "",
      payeeName: "",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a syntactically well-formed but impossible date", () => {
    // The regex this replaces matched \d{4}-\d{2}-\d{2} and accepted this.
    expect(
      createTransactionBodySchema.safeParse({ ...validCreateBody, date: "2026-13-45" }).success
    ).toBe(false);
  });

  it("accepts a real date", () => {
    expect(
      createTransactionBodySchema.safeParse({ ...validCreateBody, date: "2026-03-15" }).success
    ).toBe(true);
  });

  it("rejects a non-padded date with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({ ...validCreateBody, date: "2025-4-1" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Date must be in YYYY-MM-DD format");
  });

  it("rejects a missing date with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({ splits: validCreateBody.splits });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Date must be in YYYY-MM-DD format");
  });

  it("rejects fewer than two splits with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({
      ...validCreateBody,
      splits: [{ accountId: 1, amount: 0 }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Date and at least 2 splits are required, even for stock splits"
    );
  });

  it("rejects missing splits with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({ date: "2026-03-15" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Date and at least 2 splits are required, even for stock splits"
    );
  });

  it("rejects a non-string checkNumber with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({ ...validCreateBody, checkNumber: 1001 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("checkNumber must be a string when provided");
  });

  it("rejects a non-array investmentSplits with the ported message", () => {
    const r = createTransactionBodySchema.safeParse({
      ...validCreateBody,
      investmentSplits: "not-an-array",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "investmentSplits must be an array when provided"
    );
  });

  it("does not model bookId — that comes from the URL over HTTP", () => {
    expect(Object.keys(createTransactionBodySchema.shape)).not.toContain("bookId");
  });

  it("strips unknown keys rather than rejecting them", () => {
    const r = createTransactionBodySchema.safeParse({ ...validCreateBody, bookId: 7 });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("bookId");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // lib/transactions.ts's createTransaction() runs `if (!date || !splits
    // || splits.length < 2)` as its very first guard. The original route's
    // `const body = await request.json()` passes straight through, so an
    // array/string/number/boolean auto-boxes `date`/`splits` to undefined
    // without throwing (same as a body simply missing both keys) — only a
    // literal `null` body threw. All five had — or, for null, now gain —
    // the same combined message at 400, even though `date` is declared
    // before `splits` in the schema's shape.
    const r = createTransactionBodySchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Date and at least 2 splits are required, even for stock splits"
    );
  });

  it("a genuine object with only checkNumber invalid still reports checkNumber's own message, not the root override", () => {
    // Confirms the top-level `{ error }` added for the non-object-root case
    // above does not clobber field-level validation once the body actually
    // is an object.
    const r = createTransactionBodySchema.safeParse({
      ...validCreateBody,
      checkNumber: 123,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("checkNumber must be a string when provided");
  });
});

describe("updateTransactionBodySchema", () => {
  it("accepts an empty update", () => {
    expect(updateTransactionBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts the single-field bodies the transactions page sends", () => {
    expect(updateTransactionBodySchema.safeParse({ isReconciled: true }).success).toBe(true);
    expect(
      updateTransactionBodySchema.safeParse({ date: "2026-03-15", isFloating: false }).success
    ).toBe(true);
  });

  it("accepts null notes and payeeName (null clears the field)", () => {
    const r = updateTransactionBodySchema.safeParse({ notes: null, payeeName: null });
    expect(r.success).toBe(true);
  });

  it("rejects an impossible date", () => {
    expect(updateTransactionBodySchema.safeParse({ date: "2026-02-30" }).success).toBe(false);
  });

  it("rejects fewer than two splits with the ported message", () => {
    const r = updateTransactionBodySchema.safeParse({ splits: [{ accountId: 1, amount: 0 }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "At least 2 splits are required, even for stock splits"
    );
  });

  it("rejects a non-string checkNumber with the ported message", () => {
    const r = updateTransactionBodySchema.safeParse({ checkNumber: 1234 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("checkNumber must be a string when provided");
  });
});

describe("listTransactionsQuery", () => {
  it("accepts an empty query", () => {
    expect(listTransactionsQuery.safeParse({}).success).toBe(true);
  });

  it("accepts the params the transactions page sends", () => {
    const r = listTransactionsQuery.safeParse({
      accountIds: "4,5",
      balanceAccountId: "5",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      includeMeta: "true",
      limit: "50",
      offset: "0",
      ensureId: "12",
    });
    expect(r.success).toBe(true);
    expect(r.data!.accountIds).toEqual([4, 5]);
    expect(r.data!.limit).toBe(50);
    expect(r.data!.offset).toBe(0);
  });

  it("keeps limit=0, the route's 'no limit' sentinel", () => {
    const r = listTransactionsQuery.safeParse({ limit: "0" });
    expect(r.success).toBe(true);
    expect(r.data!.limit).toBe(0);
  });

  it("rejects an empty accountId rather than coercing it to 0", () => {
    // z.coerce.number() maps "" to 0, which would turn "no filter" into
    // "filter by account 0" — the id params are parsed through a non-empty
    // string first so this stays the 400 the route has always returned.
    const r = listTransactionsQuery.safeParse({ accountId: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects a non-numeric accountId with the ported message", () => {
    const r = listTransactionsQuery.safeParse({ accountId: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects an accountIds list with nothing numeric in it", () => {
    const r = listTransactionsQuery.safeParse({ accountIds: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountIds");
  });

  it("keeps the route's lenient accountIds parse", () => {
    // Matches the hand-written parse this replaces: non-numeric entries are
    // dropped, and only an entirely unusable list is an error.
    const r = listTransactionsQuery.safeParse({ accountIds: "4, abc ,5" });
    expect(r.success).toBe(true);
    expect(r.data!.accountIds).toEqual([4, 5]);
  });

  it("reports accountId before payeeId when both are bad", () => {
    // The routes surface only issues[0], so shape key order is what decides
    // which message the client sees; this pins the route's original order.
    const r = listTransactionsQuery.safeParse({ accountId: "abc", payeeId: "abc" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid accountId");
  });

  it("rejects an impossible startDate", () => {
    expect(listTransactionsQuery.safeParse({ startDate: "2026-13-45" }).success).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(listTransactionsQuery.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("accepts any string for includeMeta (the route enforces === 'true')", () => {
    const r = listTransactionsQuery.safeParse({ includeMeta: "yes" });
    expect(r.success).toBe(true);
    expect(r.data!.includeMeta).toBe("yes");
  });
});
