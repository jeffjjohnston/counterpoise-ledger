import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST as POSTRecurring, GET as GETRecurring } from "@/app/api/b/[bookId]/recurring/route";
import { GET as GETRecurringById, PUT as PUTRecurring, DELETE as DELETERecurring } from "@/app/api/b/[bookId]/recurring/[id]/route";
import { db } from "@/tests/helpers/db-utils";
import { recurringRules, recurringTemplateSplits, transactions } from "@/db/schema";
import { toDateString } from "@/lib/formatters";
import {
  createAccount,
  createBook,
  createPayee,
  createRecurringRule,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("Recurring rule API", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("defaults autoCreateDaysBefore to 0 when omitted on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-02-01",
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.autoCreateDaysBefore).toBe(0);
  });

  it("rejects invalid autoCreateDaysBefore on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    for (const invalidValue of [-1, 31, 1.5]) {
      const response = await POSTRecurring(
        new Request("http://localhost/api/recurring", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Invalid Rule",
            frequency: "monthly",
            startDate: "2026-02-01",
            autoCreateDaysBefore: invalidValue,
            templateSplits: [
              { accountId: rent.id, amount: 150000 },
              { accountId: checking.id, amount: -150000 },
            ],
          }),
        }),
        { params: Promise.resolve({ bookId: "1" }) }
      );

      expect(response.status).toBe(400);
    }
  });

  it("rejects invalid startDate format on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-2-01",
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/startDate/i);
  });

  it("rejects template splits that reference another book on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const otherBook = await createBook({ name: "Other Book" });
    const foreignExpense = await createAccount({
      name: "Foreign Rent",
      type: "expense",
      bookId: otherBook.id,
    });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-02-01",
          templateSplits: [
            { accountId: foreignExpense.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/account/i);
  });

  it("rejects invalid autoCreateDaysBefore on update", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    for (const invalidValue of [-1, 31, 1.5]) {
      const response = await PUTRecurring(
        new Request(`http://localhost/api/recurring/${rule.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoCreateDaysBefore: invalidValue }),
        }),
        { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
      );

      expect(response.status).toBe(400);
    }
  });

  it("rejects invalid nextDate format on update", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextDate: "2026-2-01" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/nextDate/i);
  });

  it("rejects template splits that reference another book on update", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });
    const otherBook = await createBook({ name: "Other Book" });
    const foreignExpense = await createAccount({
      name: "Foreign Rent",
      type: "expense",
      bookId: otherBook.id,
    });

    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateSplits: [
            { accountId: foreignExpense.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/account/i);
  });

  it("stores and returns payeeId on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const payee = await createPayee({ name: "Landlord" });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-02-01",
          payeeId: payee.id,
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payeeId).toBe(payee.id);
    expect(payload.payee.name).toBe("Landlord");
  });

  it("creates a new payee from payeeName on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-02-01",
          payeeName: "New Landlord",
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payeeId).not.toBeNull();
    expect(payload.payee.name).toBe("New Landlord");
  });

  it("reuses an existing payee for case-insensitive payeeName on create", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const payee = await createPayee({ name: "Landlord" });

    const response = await POSTRecurring(
      new Request("http://localhost/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Monthly Rent",
          frequency: "monthly",
          startDate: "2026-02-01",
          payeeName: "  landlord  ",
          templateSplits: [
            { accountId: rent.id, amount: 150000 },
            { accountId: checking.id, amount: -150000 },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payeeId).toBe(payee.id);
    expect(payload.payee.name).toBe("Landlord");
  });

  it("returns payeeId in GET list", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const payee = await createPayee({ name: "Landlord" });

    await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      payeeId: payee.id,
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await GETRecurring(new Request("http://localhost"), { params: Promise.resolve({ bookId: "1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0].payeeId).toBe(payee.id);
    expect(payload[0].payee.name).toBe("Landlord");
  });

  it("updates payeeId via PUT", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const payee = await createPayee({ name: "Landlord" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payeeId: payee.id }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payeeId).toBe(payee.id);
    expect(payload.payee.name).toBe("Landlord");
  });

  it("creates a new payee from payeeName via PUT", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payeeName: "Water Utility" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payeeId).not.toBeNull();
    expect(payload.payee.name).toBe("Water Utility");
  });

  it("recomputes nextDate when startDate is updated via PUT", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-02-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    // Use a future start date so the test doesn't depend on today's date
    const futureDate = "2099-06-15";
    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: futureDate }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.startDate).toBe(futureDate);
    expect(payload.nextDate).toBe(futureDate);
  });

  it("does not regress nextDate before already auto-created transactions when edited", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    // Rule that started in the future and whose cursor has already advanced past
    // Jan/Feb/Mar (as if those occurrences were already auto-created). Future dates
    // keep the test independent of today's date.
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      daysOfMonth: [15],
      startDate: "2099-01-15",
      nextDate: "2099-04-15",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    // Three transactions already auto-created from the rule.
    for (const date of ["2099-01-15", "2099-02-15", "2099-03-15"]) {
      const txn = await createTransactionWithSplits({
        date,
        description: "Rent",
        splits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });
      await db
        .update(transactions)
        .set({ recurringRuleId: rule.id })
        .where(eq(transactions.id, txn.id));
    }

    // The UI form always resubmits startDate alongside the user's change (an end
    // date here), which triggers a nextDate recompute.
    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: "2099-01-15", endDate: "2099-12-31" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    // Must resume after the last already-created occurrence (2099-03-15), not
    // regress to the start date and re-create existing transactions.
    expect(payload.nextDate).toBe("2099-04-15");
  });

  it("returns a single recurring rule by ID", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-01-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await GETRecurringById(
      new Request(`http://localhost/api/recurring/${rule.id}`),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.id).toBe(rule.id);
    expect(payload.name).toBe("Monthly Rent");
    expect(payload.templateSplits).toHaveLength(2);
  });

  it("returns 404 for nonexistent recurring rule ID", async () => {
    const response = await GETRecurringById(
      new Request("http://localhost/api/recurring/99999"),
      { params: Promise.resolve({ bookId: "1", id: "99999" }) }
    );

    expect(response.status).toBe(404);
  });

  it("deletes a recurring rule and its template splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-01-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await DELETERecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);

    // Verify rule is gone
    const getResponse = await GETRecurringById(
      new Request(`http://localhost/api/recurring/${rule.id}`),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );
    expect(getResponse.status).toBe(404);
  });

  it("returns 404 when deleting a nonexistent recurring rule", async () => {
    const response = await DELETERecurring(
      new Request("http://localhost/api/recurring/99999", { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: "99999" }) }
    );

    expect(response.status).toBe(404);
  });

  it("deletes a recurring rule even when it has generated transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2026-01-01",
      nextDate: "2026-02-01",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const txn = await createTransactionWithSplits({
      date: "2026-01-01",
      description: "Rent",
      splits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });
    await db
      .update(transactions)
      .set({ recurringRuleId: rule.id })
      .where(eq(transactions.id, txn.id));

    const response = await DELETERecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);

    const [survivingTxn] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txn.id));
    expect(survivingTxn).toBeDefined();
    expect(survivingTxn.recurringRuleId).toBeNull();
  });

  it("advances nextDate to the future when startDate is in the past", async () => {
    const checking = await createAccount({ name: "Checking2", type: "asset" });
    const rent = await createAccount({ name: "Rent2", type: "expense" });
    const rule = await createRecurringRule({
      name: "Monthly Rent Past",
      frequency: "monthly",
      startDate: "2020-01-15",
      nextDate: "2020-01-15",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await PUTRecurring(
      new Request(`http://localhost/api/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: "2020-06-15" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    const today = toDateString(new Date());
    expect(payload.nextDate >= today).toBe(true);
  });

  it("leaves no rule behind when its template splits fail to insert", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    // Both accounts exist and belong to this book, so the route's pre-insert
    // account validation passes. The amount is balanced (sums to zero) and a
    // finite number, so app-level validation passes too — but it exceeds the
    // range of the `recurring_template_splits.amount` `integer` (int4) column,
    // so the split INSERT itself fails at the database. This forces the real
    // failure mode under test: the second statement fails *after* the first
    // (the rule insert) has already succeeded.
    const response = await POSTRecurring(
      new Request("http://localhost/api/b/1/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Rule",
          frequency: "monthly",
          interval: 1,
          startDate: "2026-05-01",
          templateDescription: "Rent",
          templateSplits: [
            { accountId: checking.id, amount: -3_000_000_000 },
            { accountId: rent.id, amount: 3_000_000_000 }, // out of range for `integer` column
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);

    // The rule insert and the split insert were separate autocommits, so the
    // rule survived with zero splits — and processing would then advance its
    // nextDate forever while creating nothing.
    const rules = await db.select().from(recurringRules).where(eq(recurringRules.bookId, 1));
    expect(rules).toHaveLength(0);
  });

  it("leaves the original splits intact when an update fails", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-05-01",
      nextDate: "2026-05-01",
      templateDescription: "Rent",
      templateSplits: [
        { accountId: rent.id, amount: 100000 },
        { accountId: checking.id, amount: -100000 },
      ],
    });

    // Same technique as the POST test above: a balanced, finite amount that is
    // out of range for the `integer` column, so the account-existence and
    // splits-sum-to-zero checks pass but the split INSERT fails at the
    // database — after the DELETE of the old splits has already committed.
    const response = await PUTRecurring(
      new Request(`http://localhost/api/b/1/recurring/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Rent",
          frequency: "monthly",
          interval: 1,
          startDate: "2026-05-01",
          templateDescription: "Rent",
          templateSplits: [
            { accountId: rent.id, amount: 3_000_000_000 },
            { accountId: checking.id, amount: -3_000_000_000 }, // out of range for `integer` column
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(rule.id) }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);

    const splits = await db
      .select()
      .from(recurringTemplateSplits)
      .where(eq(recurringTemplateSplits.recurringRuleId, rule.id));
    expect(splits).toHaveLength(2);
  });
});
