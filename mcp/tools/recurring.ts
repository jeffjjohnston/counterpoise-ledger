import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import {
  createRecurringRule,
  deleteRecurringRule,
  getProjectedTransactions,
  listRecurringRules,
  listRecurringTransactions,
  RecurringRuleNotFoundError,
  RecurringRuleValidationError,
  updateRecurringRule,
} from "@/lib/recurring-rules";
import {
  processAllRecurringRules,
  processRecurringRuleById,
} from "@/lib/recurring-processing";
import {
  createRuleSchema,
  processRulesSchema,
  updateRuleSchema,
} from "@/lib/schemas/recurring";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";

export function registerRecurringTools(server: McpServer) {
  server.registerTool(
    "list_recurring_rules",
    {
      title: "List Recurring Rules",
      description:
        "List every recurring transaction rule in the book, active and inactive, each with " +
        "its payee and its template splits. Sorted active first, then by next scheduled " +
        "date. nextDate is the next SCHEDULED date; with businessDaysOnly set, an " +
        "occurrence landing on a weekend is dated the following Monday instead. There is no " +
        "separate get-one tool — read a single rule from this list.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
      },
      annotations: READ,
    },
    async ({ bookId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listRecurringRules(getDb(), bookId));
    }
  );

  server.registerTool(
    "create_recurring_rule",
    {
      title: "Create Recurring Rule",
      description:
        "Create a recurring transaction rule. templateSplits is the transaction the rule " +
        "will create each time it fires: at least two splits summing to zero, each on an " +
        "account in this book. nextDate is computed from startDate and the recurrence " +
        "fields — you cannot set it here; use update_recurring_rule to move it afterwards. " +
        "Creating a rule creates no transaction: call process_recurring_rules for that.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ...toolShape(createRuleSchema),
      },
      annotations: CREATE,
    },
    async ({ bookId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        return ok(await createRecurringRule(getDb(), bookId, input));
      } catch (error) {
        if (error instanceof RecurringRuleValidationError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "update_recurring_rule",
    {
      title: "Update Recurring Rule",
      description:
        "Update a recurring rule. Every field is optional and an omitted field is left " +
        "alone. Passing templateSplits REPLACES every existing template split, so send the " +
        "complete set. Changing any schedule field (frequency, interval, daysOfWeek, " +
        "weekOfMonth, daysOfMonth, startDate) recomputes nextDate from startDate unless you " +
        "pass nextDate yourself, and the recomputed date never moves back before the last " +
        "transaction this rule already created. To pause a rule, send isActive false rather " +
        "than deleting it.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ruleId: z.number().int().positive().describe("The recurring rule ID to update"),
        ...toolShape(updateRuleSchema),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, ruleId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        return ok(await updateRecurringRule(getDb(), bookId, ruleId, input));
      } catch (error) {
        if (
          error instanceof RecurringRuleValidationError ||
          error instanceof RecurringRuleNotFoundError
        ) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_recurring_rule",
    {
      title: "Delete Recurring Rule",
      description:
        "Delete a recurring rule and its template splits. Transactions the rule already " +
        "created are KEPT — their link to the rule is cleared, so they stop appearing in " +
        "list_recurring_transactions. This cannot be undone; to stop a rule without losing " +
        "it, set isActive false with update_recurring_rule instead.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ruleId: z.number().int().positive().describe("The recurring rule ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, ruleId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        await deleteRecurringRule(getDb(), bookId, ruleId);
        return ok({ success: true, ruleId });
      } catch (error) {
        if (error instanceof RecurringRuleNotFoundError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "get_projected_transactions",
    {
      title: "Get Projected Transactions",
      description:
        "Project the transactions that active recurring rules WILL create over a date " +
        "range, without creating anything. Defaults to tomorrow through the book's " +
        "upcoming-days window. Each projected transaction carries a negative synthetic id " +
        "and isProjected true — it is not in the ledger and its id cannot be passed to any " +
        "other tool. Use list_recurring_transactions for occurrences that already happened.",
      // Plain zod types, not lib/schemas/recurring.ts's projectedQuery: that
      // schema is shaped for URL params, where accountId arrives as a string
      // and is coerced. An MCP client sends JSON and should be told the real
      // types. Same carve-out list_payees documents.
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        startDate: z
          .iso
          .date()
          .optional()
          .describe("Inclusive start, YYYY-MM-DD. Defaults to tomorrow."),
        endDate: z
          .iso
          .date()
          .optional()
          .describe(
            "Inclusive end, YYYY-MM-DD. Defaults to today plus the book's upcomingDays."
          ),
        accountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Keep only rules with a template split on this account or on a direct child " +
              "of it. Omit for every rule."
          ),
      },
      annotations: READ,
    },
    async ({ bookId, startDate, endDate, accountId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(
        await getProjectedTransactions(getDb(), bookId, { startDate, endDate, accountId })
      );
    }
  );

  server.registerTool(
    "list_recurring_transactions",
    {
      title: "List Recurring Transactions",
      description:
        "List the transactions a recurring rule actually created within a date range, each " +
        "with the id and name of the rule that created it. Dates are effective dates, so a " +
        "floating transaction is matched on the date it currently reports. A transaction " +
        "whose rule was deleted no longer appears here.",
      // Plain zod types, not lib/schemas/recurring.ts's
      // recurringTransactionsQuery: that schema only checks that startDate
      // and endDate are present, ported from a route guard that never
      // checked their format. An MCP client sends JSON and should get real
      // date validation. Same carve-out get_projected_transactions
      // documents above.
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        startDate: z.iso.date().describe("Inclusive start of the range, YYYY-MM-DD."),
        endDate: z.iso.date().describe("Inclusive end of the range, YYYY-MM-DD."),
      },
      annotations: READ,
    },
    async ({ bookId, startDate, endDate }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listRecurringTransactions(getDb(), bookId, { startDate, endDate }));
    }
  );

  server.registerTool(
    "process_recurring_rules",
    {
      title: "Process Recurring Rules",
      description:
        "Create the transactions recurring rules are due for. With processAll true, every " +
        "active rule is processed up to its own lead window (autoCreateDaysBefore), rules " +
        "past their endDate are deactivated, and a rule that is not yet due is left alone — " +
        "so a repeat call creates nothing more. With ruleId, that ONE rule is FORCED: its " +
        "next occurrence is created and the rule advances whether or not it was due, so " +
        "calling twice creates two transactions. Passing neither creates nothing. Returns " +
        "the ids created plus a skipped list naming rules that produced nothing because " +
        "they have fewer than two template splits.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ...toolShape(processRulesSchema),
      },
      annotations: CREATE,
    },
    async ({ bookId, ruleId, processAll }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      // Branch order mirrors the route's `if (ruleId) ... else if (processAll)`,
      // including that neither flag is a no-op success rather than an error.
      if (ruleId) {
        const result = await processRecurringRuleById(getDb(), bookId, ruleId);
        if (!result) return fail("Recurring rule not found");
        return ok({ success: true, ...result });
      }

      if (processAll) {
        return ok({ success: true, ...(await processAllRecurringRules(getDb(), bookId)) });
      }

      return ok({ success: true, transactionsCreated: 0, transactionIds: [], skipped: [] });
    }
  );
}
