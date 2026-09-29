import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestDatabase, resetTestDatabase, createUser } from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { getDb } from "@/db";
import { issueReports } from "@/db/schema";
import { eq } from "drizzle-orm";

let mcp: McpTestClient;

/** An issue report row, as the create route writes it. */
async function createIssueReport(
  db: ReturnType<typeof getDb>,
  userId: number,
  input: { description: string; type: "bug" | "improvement" | "other"; page: string }
) {
  const [report] = await db.insert(issueReports).values({ userId, ...input }).returning();
  return report;
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

// The Rust server reads STATUS_DIR from its own environment, which is fixed
// when it starts, so the directory is set at connect as well as per test.
const MISSING_STATUS_DIR = "/tmp/counterpoise-test-no-such-status-dir";

describe("MCP Issue Report Tools", () => {
  const userId = 1; // the user of the test client's key

  beforeAll(async () => {
    await setupTestDatabase();

    mcp = await connectMcpTestClient({
      env: { STATUS_DIR: MISSING_STATUS_DIR },
    });
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await mcp.close();
  });

  describe("create_issue_report", () => {
    it("creates a report owned by the authenticated user", async () => {
      const { data, isError } = await callTool("create_issue_report", {
        description: "The register scrolls sideways on iPad",
        type: "bug",
        page: "/b/1/transactions",
      });

      expect(isError).toBe(false);
      expect(data.userId).toBe(userId);
      expect(data.status).toBe("new");
      expect(data.description).toBe("The register scrolls sideways on iPad");
    });

    it("defaults type to bug when omitted", async () => {
      const { data, isError } = await callTool("create_issue_report", {
        description: "Something is off",
        page: "/b/1",
      });

      expect(isError).toBe(false);
      expect(data.type).toBe("bug");
    });

    it("refuses a description of only whitespace at the schema boundary", async () => {
      // The zod schema trims before min(1); the JSON Schema that Rust
      // validates has no trim. The error is the SDK's plain text.
      const result = await mcp.client.callTool({
        name: "create_issue_report",
        arguments: { description: "   ", page: "/b/1" },
      });

      expect(result.isError).toBe(true);
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(content.text).toMatch(/^MCP error -32602: Input validation error: .*Description is required/s);
      expect(await getDb().select().from(issueReports)).toHaveLength(0);
    });

    it("stores the description trimmed", async () => {
      const { data } = await callTool("create_issue_report", {
        description: "  Padded  ",
        page: "/b/1",
      });

      expect(data.description).toBe("Padded");
    });
  });

  describe("list_issue_reports", () => {
    it("lists only the authenticated user's reports", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      await createIssueReport(getDb(), userId, { description: "Mine", type: "bug", page: "/b/1" });
      await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("list_issue_reports");

      expect(isError).toBe(false);
      expect(data).toHaveLength(1);
      expect(data[0].description).toBe("Mine");
    });
  });

  describe("update_issue_report", () => {
    it("updates a report the user owns", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("update_issue_report", {
        id: report.id,
        status: "resolved",
      });

      expect(isError).toBe(false);
      expect(data.status).toBe("resolved");
    });

    it("returns an error for another user's report", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("update_issue_report", {
        id: theirs.id,
        status: "resolved",
      });

      expect(isError).toBe(true);
      // The library names the ID; the HTTP route does not.
      expect(data.error).toBe(`Issue report ${theirs.id} not found`);

      // The guard actually guards: the other user's report is unchanged.
      const rows = await getDb().select().from(issueReports).where(eq(issueReports.id, theirs.id));
      expect(rows[0].status).toBe("new");
    });

    it("returns an error when no fields are given", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("update_issue_report", { id: report.id });

      expect(isError).toBe(true);
      expect(data.error).toBe("No valid fields to update");
    });

    it("refuses a description of only whitespace at the schema boundary", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      const result = await mcp.client.callTool({
        name: "update_issue_report",
        arguments: { id: report.id, description: " " },
      });

      expect(result.isError).toBe(true);
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(content.text).toMatch(/^MCP error -32602: Input validation error: .*Description cannot be empty/s);
    });
  });

  describe("delete_issue_report", () => {
    it("deletes a report the user owns", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("delete_issue_report", { id: report.id });

      expect(isError).toBe(false);
      expect(data).toEqual({ success: true, id: report.id });

      const rows = await getDb().select().from(issueReports).where(eq(issueReports.id, report.id));
      expect(rows).toHaveLength(0);
    });

    it("returns an error for another user's report and leaves it intact", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      const { data, isError } = await callTool("delete_issue_report", { id: theirs.id });

      expect(isError).toBe(true);
      expect(data.error).toBe(`Issue report ${theirs.id} not found`);

      const rows = await getDb().select().from(issueReports).where(eq(issueReports.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("get_system_status", () => {
    it("reports unknown when no status directory is mounted", async () => {
      const { data, isError } = await callTool("get_system_status");

      expect(isError).toBe(false);
      expect(data.overall).toBe("unknown");
      expect(data.jobs.map((j: { job: string }) => j.job)).toEqual(
        expect.arrayContaining([
          "backup",
          "prune",
          "recurring",
          "plaid-sync",
          "price-sync",
          "reindex",
        ])
      );
    });
  });
});
