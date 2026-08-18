/**
 * The web income statement and MCP's get_income_statement present the same
 * facts differently — the route returns raw signed balances, MCP returns
 * display-adjusted positives. Different presentation is fine. Different NUMBERS
 * are not, and that is exactly what the August 2026 review found when the two
 * had drifted apart on floating-date handling.
 *
 * This drives BOTH surfaces for real: the route handler and the MCP tool over
 * an in-memory transport. Calling the shared query once and deriving two
 * presentations from its rows would prove only arithmetic — it would still pass
 * if a surface stopped using the shared query, which is the drift being
 * guarded against.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET } from "@/app/api/b/[bookId]/reports/income-statement/route";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

vi.mock("@/mcp/auth", () => ({
  getMcpAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  verifyBookAccess: vi.fn().mockResolvedValue(true),
  requireAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  requireBookAuth: vi.fn().mockResolvedValue({ userId: 1, keyId: 1 }),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, getBookDb: () => actual.getDb() };
});

let client: Client;
let server: McpServer;

type WebResponse = {
  accounts: Array<{ accountId: number; name: string; type: string; balance: number }>;
  totals: { income: number; expense: number };
};

type McpResponse = {
  income: Array<{ id: number; name: string; balanceCents: number }>;
  expenses: Array<{ id: number; name: string; balanceCents: number }>;
  totals: { incomeCents: number; expensesCents: number; netIncomeCents: number };
};

async function callWebRoute(startDate: string, endDate: string): Promise<WebResponse> {
  const url = `http://test/api/b/1/reports/income-statement?startDate=${startDate}&endDate=${endDate}`;
  const response = await GET(new Request(url), {
    params: Promise.resolve({ bookId: "1" }),
  });
  return (await response.json()) as WebResponse;
}

async function callMcpTool(startDate: string, endDate: string): Promise<McpResponse> {
  const result = await client.callTool({
    name: "get_income_statement",
    arguments: { bookId: 1, startDate, endDate },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text"
  )!.text;
  return JSON.parse(text) as McpResponse;
}

describe("income statement parity between surfaces", () => {
  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "parity-test", version: "0.0.1" });
    const { registerReportTools } = await import("@/mcp/tools/reports");
    registerReportTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "parity-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("reports the same totals from both surfaces once signs are normalized", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const food = await createAccount({ name: "Food", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 250_000 },
        { accountId: salary.id, amount: -250_000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2024-03-15",
      description: "Groceries",
      splits: [
        { accountId: food.id, amount: 6_000 },
        { accountId: checking.id, amount: -6_000 },
      ],
    });

    const web = await callWebRoute("2024-01-01", "2024-12-31");
    const mcp = await callMcpTool("2024-01-01", "2024-12-31");

    // Income is credit-normal, so the route reports it negative and MCP
    // reports the display-adjusted positive.
    expect(mcp.totals.incomeCents).toBe(-web.totals.income);
    expect(mcp.totals.expensesCents).toBe(web.totals.expense);
    expect(mcp.totals.netIncomeCents).toBe(-web.totals.income - web.totals.expense);

    expect(mcp.totals.incomeCents).toBe(250_000);
    expect(mcp.totals.expensesCents).toBe(6_000);
  });

  it("places a floating transaction in the same period on both surfaces", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });

    // A floating transaction's effective date advances to today. A surface
    // querying the STORED date would put this in 2024; one using
    // effectiveDateSql puts it in the current year. That disagreement is the
    // original bug, so the two surfaces must agree about which window it lands
    // in — here, that it is absent from 2024 for both.
    await createTransactionWithSplits({
      date: "2024-03-02",
      description: "Floating grocery run",
      isFloating: true,
      splits: [
        { accountId: food.id, amount: 6_000 },
        { accountId: checking.id, amount: -6_000 },
      ],
    });

    const web = await callWebRoute("2024-01-01", "2024-12-31");
    const mcp = await callMcpTool("2024-01-01", "2024-12-31");

    expect(web.totals.expense).toBe(0);
    expect(mcp.totals.expensesCents).toBe(0);
    expect(mcp.totals.expensesCents).toBe(web.totals.expense);
  });
});
