import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import {
  createIssueReport,
  listIssueReports,
  updateIssueReport,
  deleteIssueReport,
  IssueReportValidationError,
  IssueReportNotFoundError,
} from "@/lib/issue-reports";
import { createIssueReportSchema, updateIssueReportSchema } from "@/lib/schemas/issue-reports";
import { evaluateJobHealth } from "@/lib/job-health";
import { readJobEntries, JobStatusUnreadableError } from "@/lib/job-status-store";
import { requireAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ, UPDATE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";

/**
 * get_system_status has no database read of its own. GET /api/system/status
 * (app/api/system/status/route.ts) is 27 lines, and all of its real work is
 * two calls into lib/job-health.ts and lib/job-status-store.ts — those two
 * files, not the route, are the shared library. This tool calls them
 * directly and repeats the route's small try/catch, rather than adding a
 * third file (lib/system-status.ts) that would hold nothing but that
 * try/catch.
 */

export function registerIssueReportTools(server: McpServer) {
  server.registerTool(
    "create_issue_report",
    {
      title: "Create Issue Report",
      description:
        "File a bug or improvement report about Counterpoise itself. A separate workflow " +
        "reviews these later; nothing happens immediately. Use this for a problem with the " +
        "app, not for anything about the user's financial data.",
      inputSchema: { ...toolShape(createIssueReportSchema) },
      annotations: CREATE,
    },
    async (input) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      return ok(await createIssueReport(getDb(), auth.userId, input));
    }
  );

  server.registerTool(
    "list_issue_reports",
    {
      title: "List Issue Reports",
      description:
        "List the authenticated user's own issue reports, newest first. Never returns another " +
        "user's reports.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      return ok(await listIssueReports(getDb(), auth.userId));
    }
  );

  server.registerTool(
    "update_issue_report",
    {
      title: "Update Issue Report",
      description:
        "Change the description, type, or status of one of your own issue reports. Use " +
        "list_issue_reports to find an id. At least one field must be given.",
      inputSchema: {
        id: z.number().int().positive().describe("The issue report ID to update."),
        ...toolShape(updateIssueReportSchema, {
          objectRefineHandledBy: "lib/issue-reports.ts:updateIssueReport",
        }),
      },
      annotations: UPDATE,
    },
    async ({ id, ...input }) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      try {
        return ok(await updateIssueReport(getDb(), auth.userId, id, input));
      } catch (error) {
        if (error instanceof IssueReportValidationError || error instanceof IssueReportNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_issue_report",
    {
      title: "Delete Issue Report",
      description:
        "Permanently delete one of your own issue reports. Use list_issue_reports to find an id.",
      inputSchema: {
        id: z.number().int().positive().describe("The issue report ID to delete."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;
      try {
        await deleteIssueReport(getDb(), auth.userId, id);
        return ok({ success: true, id });
      } catch (error) {
        if (error instanceof IssueReportNotFoundError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "get_system_status",
    {
      title: "Get System Status",
      description:
        "Report the health of Counterpoise's background jobs: database backup, backup " +
        "pruning, hourly recurring-transaction processing, bank sync, security price sync, and " +
        "search reindex. Each job reports one of ok, stale, unverified, failed, missing, or " +
        "unknown (no status directory mounted — the normal case in local development). Overall " +
        "is 'attention' if any job needs it.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const auth = await requireAuth();
      if ("isError" in auth) return auth;

      try {
        const entries = await readJobEntries();
        return ok(evaluateJobHealth(entries, new Date()));
      } catch (error) {
        if (error instanceof JobStatusUnreadableError) {
          // Surface it rather than degrading to "unknown", which the client
          // would treat as nothing to report — a broken monitoring path is
          // itself something to act on. Mirrors the HTTP route's own catch.
          return ok({
            ...evaluateJobHealth(null, new Date()),
            overall: "attention" as const,
            error: error.message,
          });
        }
        throw error;
      }
    }
  );
}
