import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { generateApiKey, getKeyPrefix, hashApiKey } from "./api-keys";
import { count, insert } from "./sql";
import { startHttpTestServer } from "./http-parity";
import { workerDatabasePath } from "./test-database";
import { callMcpTool, type McpCallResult } from "./mcp";

/** The text and error flag of a tool result, undecoded. */
export type RawToolResult = { isError: boolean; text: string };

async function rawCall(client: Client, name: string, args: Record<string, unknown>): Promise<RawToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return { isError: Boolean(result.isError), text: content?.text ?? "" };
}

/**
 * The transport to the Rust MCP server: `COUNTERPOISE_MCP_TRANSPORT=stdio`
 * (`npm run test:mcp:stdio`), or `http` (`npm run test:mcp:http`).
 */
export function mcpTestTransport(): "http" | "stdio" {
  return process.env.COUNTERPOISE_MCP_TRANSPORT === "stdio" ? "stdio" : "http";
}

/** The Rust server binary that `cargo build -p counterpoise-rust-api` writes. */
export const RUST_SERVER_BINARY = resolve("rust-api/target/debug/counterpoise-rust-api");

/**
 * The environment of a Rust stdio server: this worker's database, the key, and
 * the caller's `env`. Its stderr is kept for the error of a failed start.
 */
export function stdioServerParameters(
  key: string | undefined,
  env: Record<string, string> = {}
): { command: string; args: string[]; env: Record<string, string>; stderr: "pipe" } {
  return {
    command: RUST_SERVER_BINARY,
    args: ["mcp"],
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      NODE_ENV: "production",
      ...(key === undefined ? {} : { COUNTERPOISE_API_KEY: key }),
      ...env,
    },
    stderr: "pipe",
  };
}

export type McpTestClient = {
  /** A client that acts as the seeded user 1. */
  client: Client;
  /** Call a tool as `userId`, with a key of that user. */
  callAs: (userId: number, name: string, args?: Record<string, unknown>) => Promise<McpCallResult>;
  /** As callAs, but the raw result: for an error the server reports as plain text, not fail()'s JSON. */
  callToolAs: (userId: number, name: string, args?: Record<string, unknown>) => Promise<RawToolResult>;
  close: () => Promise<void>;
};

/**
 * Connect a client to the Rust MCP server.
 *
 * The client sends a real API key of the seeded user 1, so the server checks
 * it as it would any client's. `resetTestDatabase` deletes every key, so the
 * client adds the key again before each request when it is gone. Over HTTP the
 * key is the bearer header of each request. Over stdio each user gets a server
 * process of its own, with the key in `COUNTERPOISE_API_KEY`.
 *
 * `env` sets variables of the Rust server process. That process starts once,
 * so a test that changes `process.env` later does not reach it.
 */
export async function connectMcpTestClient(
  { env = {} }: { env?: Record<string, string> } = {}
): Promise<McpTestClient> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const stdio = mcpTestTransport() === "stdio";
  const http = stdio ? undefined : await startHttpTestServer(env);
  const clients = new Map<number, Client>();
  const connect = async (userId: number, userClient: Client) => {
    const key = generateApiKey();
    const keyHash = await hashApiKey(key);
    const ensureKey = async () => {
      if (await count("api_keys", "key_hash = $1", [keyHash]) === 0) {
        await insert("api_keys", { userId, name: "MCP test", keyHash, keyPrefix: getKeyPrefix(key) });
      }
    };
    if (stdio) {
      const transport = new StdioClientTransport(stdioServerParameters(key, env));
      let output = "";
      transport.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); });
      // The key goes in before each message, as the HTTP fetch hook does.
      const send = transport.send.bind(transport);
      transport.send = async (message) => {
        await ensureKey();
        return send(message);
      };
      try {
        await userClient.connect(transport);
      } catch (cause) {
        throw new Error(`The Rust stdio MCP server did not start:\n${output}`, { cause });
      }
      clients.set(userId, userClient);
      return userClient;
    }
    const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", http!.baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
      fetch: async (input, init) => {
        await ensureKey();
        return fetch(input, init);
      },
    });
    await userClient.connect(transport);
    clients.set(userId, userClient);
    return userClient;
  };
  await connect(1, client);
  const clientFor = async (userId: number) =>
    clients.get(userId) ?? connect(userId, new Client({ name: "test-client", version: "0.0.1" }));
  return {
    client,
    callAs: async (userId, name, args = {}) => callMcpTool(await clientFor(userId), name, args),
    callToolAs: async (userId, name, args = {}) => rawCall(await clientFor(userId), name, args),
    close: async () => {
      for (const userClient of clients.values()) await userClient.close();
      await http?.stop();
    },
  };
}
