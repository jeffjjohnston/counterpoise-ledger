import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "@/mcp/register-all";

export type WebMcpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

let clientPromise: Promise<Client> | undefined;

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "counterpoise-webmcp", version: "1.0.0" });
  registerAllTools(server);

  const client = new Client({ name: "counterpoise-webmcp", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

export function getWebMcpClient(): Promise<Client> {
  clientPromise ??= createClient();
  return clientPromise;
}

/**
 * Tools the browser registry does not carry, for two reasons that happen to
 * agree.
 *
 * Scope: the page is already pinned to one book, so book management, the
 * Counterpoise issue tracker, PostHog analytics, background-job health and
 * Plaid connection administration are not work an agent driving a ledger page
 * should be doing.
 *
 * Budget: the registry is measured whole. A browser build sums the serialized
 * descriptors - names, titles, descriptions, input schemas and annotations
 * together - and rejects the entire registry past 65,536 bytes, disabling
 * WebMCP for the page with an error that names no limit. All 59 tools come to
 * 68,231 bytes. Excluding these brings it to 53,173 and leaves every remaining
 * tool at full fidelity, which is the better trade than stripping parameter
 * documentation from all 59. `tests/mcp/webmcp-budget.test.ts` holds the line.
 */
const WEB_EXCLUDED_TOOLS = new Set([
  "list_books",
  "create_book",
  "update_book",
  "create_demo_book",
  "delete_book",
  "analyze_usage",
  "get_system_status",
  "create_issue_report",
  "list_issue_reports",
  "update_issue_report",
  "delete_issue_report",
  "list_plaid_token_accounts",
  "update_plaid_token",
  "delete_plaid_token",
  "set_plaid_token_accounts",
  "sync_plaid_token",
  "clear_plaid_sync_data",
]);

function forBrowser(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  delete properties.bookId;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => name !== "bookId")
    : undefined;

  const shaped: Record<string, unknown> = {
    ...schema,
    properties,
    ...(required && required.length > 0 ? { required } : { required: undefined }),
  };
  // `$schema` is the same 52 bytes on every tool and tells the browser nothing
  // it acts on, so it is dead weight against the registry byte budget.
  delete shaped.$schema;
  return shaped;
}

export async function listWebMcpTools(): Promise<WebMcpToolDefinition[]> {
  const client = await getWebMcpClient();
  const { tools } = await client.listTools();
  return tools
    .filter((tool) => !WEB_EXCLUDED_TOOLS.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: forBrowser(tool.inputSchema as Record<string, unknown>),
      annotations: tool.annotations as Record<string, unknown> | undefined,
    }));
}

export async function callWebMcpTool(
  name: string,
  args: Record<string, unknown>,
  bookId: number
): Promise<unknown> {
  const client = await getWebMcpClient();
  const { tools } = await client.listTools();
  // Withheld tools must be uncallable, not merely unlisted - the endpoint is
  // reachable by anything holding the session cookie, whether or not it read
  // the registry. Reported as unknown so the reply does not confirm that a
  // withheld tool exists.
  const tool = WEB_EXCLUDED_TOOLS.has(name)
    ? undefined
    : tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);

  const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
  const argumentsWithScope = properties?.bookId
    ? { ...args, bookId }
    : args;
  const result = await client.callTool({ name, arguments: argumentsWithScope });
  const text = (result.content as Array<{ type: string; text?: string }>).find(
    (item) => item.type === "text"
  )?.text;
  const payload = text === undefined ? result.structuredContent ?? null : JSON.parse(text);
  if (result.isError) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `MCP tool ${name} failed`;
    throw new Error(message);
  }
  return payload;
}
