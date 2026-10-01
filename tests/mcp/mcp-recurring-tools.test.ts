import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createRecurringRule,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count, row, rows } from "@/tests/helpers/sql";
import type { RecurringRule, Transaction } from "@/types/db";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Recurring Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    mcp = await connectMcpTestClient();
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await mcp.close();
  });

  async function fixture() {
    const checking = await createAccount({
      name: "Checking", type: "asset", subtype: "bank", bookId,
    });
    const rent = await createAccount({
      name: "Rent", type: "expense", subtype: "other", bookId,
    });
    return { checking, rent };
  }

  async function seedRule(overrides: { nextDate?: string; name?: string } = {}) {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: overrides.name ?? "Rent",
      frequency: "monthly",
      startDate: "2026-01-15",
      nextDate: overrides.nextDate ?? "2026-09-15",
      templateDescription: "Rent payment",
      bookId,
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });
    return { rule, checking, rent };
  }

  describe("list_recurring_rules", () => {
    it("returns rules with payee and template splits, active first", async () => {
      const { checking, rent } = await fixture();
      const inactive = await createRecurringRule({
        name: "Old", frequency: "monthly", startDate: "2025-01-01",
        nextDate: "2025-02-01", isActive: false, bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      const active = await createRecurringRule({
        name: "Rent", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-09-15", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });

      const { data, isError } = await callTool("list_recurring_rules", { bookId });

      expect(isError).toBe(false);
      expect(data.map((r: { id: number }) => r.id)).toEqual([active.id, inactive.id]);
      expect(data[0].templateSplits).toHaveLength(2);
      expect(data[0].templateSplits[0].account.name).toBeDefined();
    });

    it("returns an empty list for a book with no rules", async () => {
      const { data, isError } = await callTool("list_recurring_rules", { bookId });
      expect(isError).toBe(false);
      expect(data).toEqual([]);
    });
  });

  describe("create_recurring_rule", () => {
    it("creates a rule and computes nextDate from startDate", async () => {
      const { checking, rent } = await fixture();

      const { data, isError } = await callTool("create_recurring_rule", {
        bookId,
        name: "Rent",
        frequency: "monthly",
        startDate: "2020-01-15",
        templateDescription: "Rent payment",
        templateSplits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("Rent");
      expect(data.startDate).toBe("2020-01-15");
      // advanceNextDateToFuture walks past today, so a long-past startDate
      // does not land the rule instantly overdue.
      expect(data.nextDate > "2020-01-15").toBe(true);
      expect(data.templateSplits).toHaveLength(2);
    });

    it("returns isError when the template splits do not sum to zero", async () => {
      const { checking, rent } = await fixture();

      const { data, isError } = await callTool("create_recurring_rule", {
        bookId,
        name: "Bad",
        frequency: "monthly",
        startDate: "2026-01-15",
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -99 },
        ],
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/sum to zero/i);

      const rules = await rows<RecurringRule>("SELECT * FROM recurring_rules");
      expect(rules).toEqual([]);
    });

    it("does not publish endDate as required", async () => {
      // Regression guard for Step 1. zod accepted an absent endDate all
      // along; the published JSON Schema said otherwise, and the schema is
      // what a model reads.
      const { tools } = await mcp.client.listTools();
      const create = tools.find((t) => t.name === "create_recurring_rule");
      expect(create?.inputSchema.required).not.toContain("endDate");
    });

    it("takes an empty endDate as no end, as the create form sends it", async () => {
      // zod preprocesses "" to null. The published JSON Schema cannot say
      // so and refuses "", so the Rust server applies the same preprocess
      // before its schema check.
      const { checking, rent } = await fixture();

      const { data, isError } = await callTool("create_recurring_rule", {
        bookId,
        name: "Rent",
        frequency: "monthly",
        startDate: "2026-01-15",
        endDate: "",
        templateSplits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.endDate).toBeNull();
    });
  });

  describe("update_recurring_rule", () => {
    it("replaces every template split it is given", async () => {
      const { rule, checking } = await seedRule();
      const groceries = await createAccount({
        name: "Groceries", type: "expense", subtype: "other", bookId,
      });

      const { data, isError } = await callTool("update_recurring_rule", {
        bookId,
        ruleId: rule.id,
        templateSplits: [
          { accountId: groceries.id, amount: 250 },
          { accountId: checking.id, amount: -250 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.templateSplits).toHaveLength(2);
      expect(
        data.templateSplits.map((s: { accountId: number }) => s.accountId).sort()
      ).toEqual([groceries.id, checking.id].sort());

      expect(await count("recurring_template_splits", "recurring_rule_id = $1", [rule.id])).toBe(2);
    });

    it("errors on another book's rule AND leaves that rule unchanged", async () => {
      const otherBook = await createBook({ name: "Other" });
      const a = await createAccount({
        name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
      });
      const b = await createAccount({
        name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
      });
      const theirs = await createRecurringRule({
        name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-08-01", bookId: otherBook.id,
        templateSplits: [
          { accountId: b.id, amount: 100 },
          { accountId: a.id, amount: -100 },
        ],
      });

      const { isError } = await callTool("update_recurring_rule", {
        bookId,
        ruleId: theirs.id,
        name: "Mine now",
      });

      expect(isError).toBe(true);
      // The second half is the assertion that matters: "it errored" is also
      // satisfied by a tool that errors for the wrong reason.
      const still = await row<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [theirs.id]);
      expect(still.name).toBe("Theirs");
    });

    it("returns isError with a message for a null nextDate, instead of throwing", async () => {
      // The tool's inputSchema publishes nextDate as nullable, so a model can
      // send null. The tool must answer isError, not let the driver error
      // escape as an uncaught exception.
      const { rule } = await seedRule();

      const { data, isError } = await callTool("update_recurring_rule", {
        bookId,
        ruleId: rule.id,
        nextDate: null,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/nextDate/i);
    });
  });

  describe("delete_recurring_rule", () => {
    it("deletes the rule and keeps the transactions it created", async () => {
      const { rule, checking, rent } = await seedRule();
      const created = await createTransactionWithSplits({
        bookId, date: "2026-08-15", description: "Rent", recurringRuleId: rule.id,
        splits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });

      const { isError } = await callTool("delete_recurring_rule", { bookId, ruleId: rule.id });

      expect(isError).toBe(false);
      const rules = await rows<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [rule.id]);
      expect(rules).toEqual([]);

      const [tx] = await rows<Transaction>("SELECT * FROM transactions WHERE id = $1", [created.id]);
      expect(tx).toBeDefined();
      expect(tx.recurringRuleId).toBeNull();
    });

    it("returns isError for an unknown rule id", async () => {
      const { data, isError } = await callTool("delete_recurring_rule", {
        bookId,
        ruleId: 999999,
      });
      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });

  describe("get_projected_transactions", () => {
    it("projects future occurrences without creating anything", async () => {
      await seedRule({ nextDate: "2026-09-15" });

      const { data, isError } = await callTool("get_projected_transactions", {
        bookId,
        startDate: "2026-09-01",
        endDate: "2026-11-30",
      });

      expect(isError).toBe(false);
      expect(data.map((p: { date: string }) => p.date)).toEqual([
        "2026-09-15",
        "2026-10-15",
        "2026-11-15",
      ]);
      expect(data.every((p: { isProjected: boolean }) => p.isProjected)).toBe(true);
      expect(data.every((p: { id: number }) => p.id < 0)).toBe(true);

      // A projection tool that quietly created rows would pass every
      // assertion above.
      expect(await rows("SELECT * FROM transactions")).toEqual([]);
    });

    it("filters by accountId, including a direct child of it", async () => {
      const { checking } = await seedRule();
      const utilities = await createAccount({
        name: "Utilities", type: "expense", subtype: "other", bookId,
      });
      const power = await createAccount({
        name: "Power", type: "expense", subtype: "other", parentId: utilities.id, bookId,
      });
      await createRecurringRule({
        name: "Power bill", frequency: "monthly", startDate: "2026-01-20",
        nextDate: "2026-09-20", templateDescription: "Power bill", bookId,
        templateSplits: [
          { accountId: power.id, amount: 8000 },
          { accountId: checking.id, amount: -8000 },
        ],
      });

      const { data } = await callTool("get_projected_transactions", {
        bookId,
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        accountId: utilities.id,
      });

      expect(data.map((p: { description: string }) => p.description)).toEqual(["Power bill"]);
    });
  });

  describe("list_recurring_transactions", () => {
    it("returns only rule-created transactions in range, with the rule name", async () => {
      const { rule, checking, rent } = await seedRule();
      const fromRule = await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Rent", recurringRuleId: rule.id,
        splits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-16", description: "Manual",
        splits: [
          { accountId: rent.id, amount: 900 },
          { accountId: checking.id, amount: -900 },
        ],
      });

      const { data, isError } = await callTool("list_recurring_transactions", {
        bookId,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(isError).toBe(false);
      expect(data).toEqual([
        {
          transactionId: fromRule.id,
          date: "2026-01-15",
          recurringRuleId: rule.id,
          ruleName: "Rent",
        },
      ]);
    });
  });

  describe("process_recurring_rules", () => {
    it("creates nothing when neither ruleId nor processAll is given", async () => {
      await seedRule({ nextDate: "2020-01-15" });

      const { data, isError } = await callTool("process_recurring_rules", { bookId });

      expect(isError).toBe(false);
      expect(data).toEqual({
        success: true,
        transactionsCreated: 0,
        transactionIds: [],
        skipped: [],
      });
      expect(await rows("SELECT * FROM transactions")).toEqual([]);
    });

    it("creates due transactions with processAll, and a repeat call creates none", async () => {
      // nextDate in the past, so the rule is overdue and gets caught up.
      await seedRule({ nextDate: "2026-01-15" });

      const first = await callTool("process_recurring_rules", { bookId, processAll: true });
      expect(first.isError).toBe(false);
      expect(first.data.transactionsCreated).toBeGreaterThan(0);
      const afterFirst = await rows("SELECT * FROM transactions");

      const second = await callTool("process_recurring_rules", { bookId, processAll: true });
      expect(second.data.transactionsCreated).toBe(0);
      expect(await rows("SELECT * FROM transactions")).toHaveLength(afterFirst.length);
    });

    it("forces an occurrence with ruleId even when the rule is not due", async () => {
      // Far-future nextDate: processAll would skip this rule entirely.
      const { rule } = await seedRule({ nextDate: "2030-09-15" });

      const skipped = await callTool("process_recurring_rules", { bookId, processAll: true });
      expect(skipped.data.transactionsCreated).toBe(0);

      const forced = await callTool("process_recurring_rules", { bookId, ruleId: rule.id });
      expect(forced.isError).toBe(false);
      expect(forced.data.transactionsCreated).toBe(1);

      const updated = await row<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [rule.id]);
      expect(updated.nextDate).toBe("2030-10-15");

      // Not idempotent, which is why the tool is annotated CREATE and its
      // description warns that calling twice creates two transactions.
      const again = await callTool("process_recurring_rules", { bookId, ruleId: rule.id });
      expect(again.data.transactionsCreated).toBe(1);
      expect(await rows("SELECT * FROM transactions")).toHaveLength(2);
    });

    it("returns isError for an unknown ruleId", async () => {
      const { data, isError } = await callTool("process_recurring_rules", {
        bookId,
        ruleId: 999999,
      });
      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });
});
