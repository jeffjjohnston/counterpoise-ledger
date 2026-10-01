import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import manifest from "../../rust-api/server/mcp-tools.json";
import {
  addBookMember, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { insert, row, rows } from "../helpers/sql";
import type { Account } from "../../types/db";
import { startHttpTestServer } from "../helpers/http-parity";

/**
 * A browser build measures the whole registry - every descriptor's name,
 * title, description, input schema and annotations, serialized together - and
 * rejects all of it past 65,536 bytes. The page then loses WebMCP entirely,
 * and the error names no limit, so a regression here is expensive to diagnose
 * from the symptom.
 */
const REGISTRY_BYTE_LIMIT = 65_536;

/**
 * Deliberately below the real cap. The reserve absorbs a tool or two before
 * anyone has to think about the budget again.
 */
const BUDGET = 58_000;

/** WEB_EXCLUDED_TOOLS in rust-api/server/src/mcp/webmcp.rs. */
const EXCLUDED = new Set([
  "list_books", "create_book", "update_book", "create_demo_book", "delete_book",
  "list_book_members", "add_book_member", "update_book_member", "remove_book_member",
  "analyze_usage", "get_system_status",
  "create_issue_report", "list_issue_reports", "update_issue_report", "delete_issue_report",
  "list_plaid_token_accounts", "update_plaid_token", "delete_plaid_token",
  "set_plaid_token_accounts", "sync_plaid_token", "clear_plaid_sync_data",
]);

type ManifestTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
};

/** A manifest tool as the browser takes it: no bookId, no $schema. */
function forBrowser(tool: ManifestTool) {
  const without = (object: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
  const rest = without(tool.inputSchema, "$schema", "required");
  const properties = without(tool.inputSchema.properties ?? {}, "bookId");
  const required = (tool.inputSchema.required ?? []).filter((name) => name !== "bookId");
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description ?? tool.title ?? tool.name,
    inputSchema: { ...rest, properties, ...(required.length > 0 ? { required } : {}) },
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
}

const WITHHELD = [
  "delete_book",
  "create_book",
  "analyze_usage",
  "delete_plaid_token",
  "create_issue_report",
  "add_book_member",
  "remove_book_member",
];

type Descriptor = { name: string; inputSchema: { properties?: object } };

describe("WebMCP", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  /** A session cookie for a user, as the browser sends it. */
  async function cookieFor(userId: number): Promise<string> {
    const token = randomBytes(32).toString("hex");
    await insert("sessions", {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return `counterpoise_session=${token}`;
  }

  const get = (cookie?: string, bookId = 1) =>
    fetch(new URL(`/api/b/${bookId}/webmcp`, baseUrl), { headers: cookie ? { cookie } : {} });

  const post = (cookie: string, body: string | object, bookId = 1) =>
    fetch(new URL(`/api/b/${bookId}/webmcp`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(resetTestDatabase);
  afterAll(async () => { await stop?.(); });

  describe("tool list", () => {
    it("gives each manifest tool that is not withheld, in manifest order", async () => {
      const response = await get(await cookieFor(1));
      expect(response.status).toBe(200);
      const expected = (manifest as ManifestTool[])
        .filter((tool) => !EXCLUDED.has(tool.name))
        .map(forBrowser);
      expect(await response.json()).toEqual(expected);
    });

    it("stays inside the byte budget and the tool count the browser enforces", async () => {
      const text = await (await get(await cookieFor(1))).text();
      const bytes = Buffer.byteLength(text, "utf8");
      expect(bytes).toBeLessThan(BUDGET);
      expect(bytes).toBeLessThan(REGISTRY_BYTE_LIMIT);
      expect((JSON.parse(text) as unknown[]).length).toBeLessThanOrEqual(100);
    });

    it("hides bookId and $schema, and withholds the admin tools", async () => {
      const tools = (await (await get(await cookieFor(1))).json()) as Descriptor[];
      for (const tool of tools) {
        expect(tool.inputSchema).not.toHaveProperty("$schema");
        expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("bookId");
      }
      const names = new Set(tools.map((tool) => tool.name));
      for (const name of WITHHELD) expect(names.has(name)).toBe(false);
      for (const name of [
        "list_accounts", "create_transaction", "list_transactions",
        "get_income_statement", "reconcile_plaid_transaction",
      ]) {
        expect(names.has(name)).toBe(true);
      }
    });

    it("needs a session, and membership of the book", async () => {
      expect((await get()).status).toBe(401);
      const stranger = await createUser({ username: "stranger" });
      const denied = await get(await cookieFor(stranger.id));
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "Book not found" });
      const viewer = await createUser({ username: "viewer" });
      await addBookMember({ bookId: 1, userId: viewer.id, role: "viewer" });
      expect((await get(await cookieFor(viewer.id))).status).toBe(200);
    });
  });

  describe("tool call", () => {
    it("runs a tool in the URL's book, whatever bookId the caller sends", async () => {
      const response = await post(await cookieFor(1), {
        name: "create_account",
        arguments: { bookId: 999, name: "Cash", type: "asset" },
      });
      expect(response.status).toBe(200);
      const account = await response.json();
      expect(account).toMatchObject({ name: "Cash", type: "asset" });
      const stored = await row<Account>("SELECT * FROM accounts WHERE id = $1", [account.id]);
      expect(stored.bookId).toBe(1);
    });

    it("gives a read tool's JSON", async () => {
      const response = await post(await cookieFor(1), { name: "list_accounts", arguments: {} });
      expect(response.status).toBe(200);
      expect(Array.isArray(await response.json())).toBe(true);
    });

    it("lets each tool check its own level: a viewer reads but cannot write", async () => {
      const viewer = await createUser({ username: "viewer" });
      await addBookMember({ bookId: 1, userId: viewer.id, role: "viewer" });
      const cookie = await cookieFor(viewer.id);
      expect((await post(cookie, { name: "list_accounts", arguments: {} })).status).toBe(200);
      const refused = await post(cookie, {
        name: "create_account",
        arguments: { name: "Cash", type: "asset" },
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "You have read-only access to this book" });
      expect(await rows("SELECT * FROM accounts WHERE name = $1", ["Cash"])).toEqual([]);
    });

    it("refuses to run a withheld or unknown tool, not merely to list it", async () => {
      const cookie = await cookieFor(1);
      for (const name of [...WITHHELD, "no_such_tool"]) {
        const response = await post(cookie, { name, arguments: {} });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: `Unknown MCP tool: ${name}` });
      }
    });

    it("gives the input error as the message when the arguments fail the schema", async () => {
      const response = await post(await cookieFor(1), {
        name: "create_account",
        arguments: { name: "Cash", type: "nonsense" },
      });
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool create_account: /);
    });

    it("refuses a body that is not a tool call", async () => {
      const cookie = await cookieFor(1);
      for (const [body, message] of [
        ["not json", "A JSON request body is required"],
        ["null", "A JSON request body is required"],
        ["\"text\"", "A JSON request body is required"],
        [{ arguments: {} }, "name and arguments are required"],
        [{ name: 1, arguments: {} }, "name and arguments are required"],
        [{ name: "list_accounts" }, "name and arguments are required"],
        [{ name: "list_accounts", arguments: [] }, "name and arguments are required"],
        [[], "name and arguments are required"],
      ] as const) {
        const response = await post(cookie, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: message });
      }
    });

    it("checks the book before the body", async () => {
      const stranger = await createUser({ username: "stranger" });
      const response = await post(await cookieFor(stranger.id), "not json");
      expect(response.status).toBe(404);
    });
  });
});
