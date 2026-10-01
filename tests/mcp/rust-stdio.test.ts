import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateApiKey, getKeyPrefix, hashApiKey } from "@/tests/helpers/api-keys";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { exec, insert } from "@/tests/helpers/sql";
import { callMcpTool } from "@/tests/helpers/mcp";
import {
  RUST_SERVER_BINARY, mcpTestTransport, stdioServerParameters,
} from "@/tests/helpers/mcp-client";
import manifest from "@/rust-api/server/mcp-tools.json";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

/** `counterpoise-rust-api mcp`: the key, revocation, and a clean stdout. */
describe.skipIf(mcpTestTransport() !== "stdio")("Rust MCP over stdio", () => {
  let key: string;
  let client: Client | undefined;

  const connect = async (withKey: string | undefined) => {
    client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(new StdioClientTransport(stdioServerParameters(withKey)));
    return client;
  };

  beforeAll(setupTestDatabase, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    key = generateApiKey();
    await insert("api_keys", { userId: 1, name: "t", keyHash: await hashApiKey(key), keyPrefix: getKeyPrefix(key) });
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("lists every manifest tool and answers as the key's user", async () => {
    const mcp = await connect(key);
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(manifest.map((tool) => tool.name).sort());
    const books = await callMcpTool(mcp, "list_books");
    expect(books.isError).toBe(false);
    expect(books.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 1 })]));
  });

  it("refuses every tool without a key, and with an unknown key", async () => {
    for (const credential of [undefined, generateApiKey()]) {
      const mcp = await connect(credential);
      const result = await callMcpTool(mcp, "list_books");
      expect(result.isError).toBe(true);
      expect(result.data).toEqual({ error: "A valid COUNTERPOISE_API_KEY is required" });
      await mcp.close();
    }
  });

  it("stops a revoked key at the next call, without a restart", async () => {
    const mcp = await connect(key);
    expect((await callMcpTool(mcp, "list_books")).isError).toBe(false);
    await exec("DELETE FROM api_keys");
    const result = await callMcpTool(mcp, "list_books");
    expect(result.isError).toBe(true);
    expect(result.data).toEqual({ error: "A valid COUNTERPOISE_API_KEY is required" });
  });

  it("writes only protocol messages to stdout, and its logs to stderr", async () => {
    const { env } = stdioServerParameters(key);
    const child = spawn(RUST_SERVER_BINARY, ["mcp"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    child.stdin.end(
      [
        INITIALIZE,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_books", arguments: {} } },
      ].map((message) => JSON.stringify(message)).join("\n") + "\n"
    );
    expect(await exited).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
    expect(stderr).toContain("MCP authenticated");
  });
});
