import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupTestDatabase, resetTestDatabase, createUser } from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { issueReports } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createIssueReport } from "@/lib/issue-reports";

// Issue reports are user-scoped, not book-scoped: every tool here calls
// requireAuth(), never requireBookAuth(). Mock auth to the same userId the
// seeded test user (tests/helpers/db-utils.ts) has, same pattern as
// mcp-book-tools.test.ts.
vi.mock("@/mcp/auth", () => ({
  getMcpAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  verifyBookAccess: vi.fn().mockResolvedValue(true),
  requireAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  requireBookAuth: vi.fn().mockResolvedValue({ userId: 1, keyId: 1 }),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual };
});

let client: Client;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError ?? false;
  const textContent = (result.content as Array<{ type: string; text: string }>)?.find(
    (c) => c.type === "text"
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  if (isError) {
    try {
      data = textContent ? JSON.parse(textContent.text) : undefined;
    } catch {
      data = { error: textContent?.text };
    }
  } else {
    data = textContent ? JSON.parse(textContent.text) : undefined;
  }
  return { data, isError };
}

describe("MCP Issue Report Tools", () => {
  const userId = 1; // matches the mocked requireAuth() above

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerIssueReportTools } = await import("@/mcp/tools/issue-reports");
    registerIssueReportTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
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
      expect(data.error).toMatch(/not found/i);

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
      expect(data.error).toMatch(/no valid fields/i);
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
      expect(data.success).toBe(true);

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
      expect(data.error).toMatch(/not found/i);

      const rows = await getDb().select().from(issueReports).where(eq(issueReports.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("get_system_status", () => {
    const originalStatusDir = process.env.STATUS_DIR;

    afterEach(() => {
      if (originalStatusDir === undefined) delete process.env.STATUS_DIR;
      else process.env.STATUS_DIR = originalStatusDir;
    });

    it("reports unknown when no status directory is mounted", async () => {
      process.env.STATUS_DIR = "/tmp/counterpoise-test-no-such-status-dir";

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
