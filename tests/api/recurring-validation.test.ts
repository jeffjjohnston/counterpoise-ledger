import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as POSTRecurring } from "@/app/api/b/[bookId]/recurring/route";
import { PUT as PUTRecurring } from "@/app/api/b/[bookId]/recurring/[id]/route";
import { POST as POSTProcess } from "@/app/api/b/[bookId]/recurring/process/route";
import { GET as GETProjected } from "@/app/api/b/[bookId]/recurring/projected/route";
import { GET as GETRecurringTxns } from "@/app/api/b/[bookId]/recurring/transactions/route";
import {
  createAccount,
  createRecurringRule,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

// Regression guards for the createRuleSchema / updateRuleSchema /
// processRulesSchema / projectedQuery / recurringTransactionsQuery wiring
// across all five recurring routes. If a future edit hands a route raw,
// unparsed input again, these are the tests that catch it.

describe("POST /api/b/[bookId]/recurring schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an unknown frequency with 400, not a silent write", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const res = await POSTRecurring(
      new Request("http://localhost/api/b/1/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Rent",
          frequency: "biweekly",
          startDate: "2026-02-01",
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      rp()
    );

    // recurring_rules.frequency is a plain `text` column with no CHECK
    // constraint (Drizzle's `{ enum: [...] }` is TypeScript-only — see
    // CLAUDE.md), so this used to be silently persisted and would have
    // quietly broken recurrence math (getNextDate has no "biweekly" case).
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid frequency");
  });
});

describe("PUT /api/b/[bookId]/recurring/[id] schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an unknown frequency with 400, not a silent write", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const res = await PUTRecurring(
      new Request(`http://localhost/api/b/1/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frequency: "quarterly" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid frequency");
  });
});

describe("POST /api/b/[bookId]/recurring/process schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a non-boolean processAll with 400 instead of silently no-op'ing", async () => {
    const res = await POSTProcess(
      new Request("http://localhost/api/b/1/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processAll: "yes" }),
      }),
      rp()
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/b/[bookId]/recurring/projected schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a non-numeric accountId instead of silently returning an empty list", async () => {
    // Previously `accountIdParam ? parseInt(accountIdParam, 10) : null`
    // turned this into NaN, which never equals any real account id — the
    // route quietly returned `[]` instead of erroring.
    const res = await GETProjected(
      new Request("http://localhost/api/b/1/recurring/projected?accountId=abc"),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid accountId");
  });

  it("rejects a malformed startDate instead of silently misprojecting", async () => {
    const res = await GETProjected(
      new Request("http://localhost/api/b/1/recurring/projected?startDate=not-a-date"),
      rp()
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/b/[bookId]/recurring/transactions schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an empty-string startDate the same as an absent one", async () => {
    const res = await GETRecurringTxns(
      new Request(
        "http://localhost/api/b/1/recurring/transactions?startDate=&endDate=2025-01-31"
      ),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("startDate and endDate are required");
  });
});
