import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateApiKey, getKeyPrefix, hashApiKey } from "@/tests/helpers/api-keys";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { exec, insert } from "@/tests/helpers/sql";
import { startHttpTestServer } from "@/tests/helpers/http-parity";
import { callMcpTool } from "@/tests/helpers/mcp";
import { mcpTestTransport } from "@/tests/helpers/mcp-client";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

/** The HTTP gate of the Rust `/api/mcp`: the key, the cookie, and Origin. */
describe.skipIf(mcpTestTransport() !== "http")("Rust MCP transport", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let key: string;

  const post = (headers: Record<string, string>) =>
    fetch(new URL("/api/mcp", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(INITIALIZE),
    });

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    key = generateApiKey();
    await insert("api_keys", { userId: 1, name: "t", keyHash: await hashApiKey(key), keyPrefix: getKeyPrefix(key) });
  });

  afterAll(async () => {
    await stop();
  });

  it("answers initialize for a valid key", async () => {
    const response = await post({ authorization: `Bearer ${key}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: "counterpoise" } } });
  });

  // Claude Code uses the stateless lifecycle of 2026-07-28: server/discover,
  // then requests that carry the version in their _meta, with no initialize.
  // That version requires ttlMs and cacheScope on a list result (SEP-2549),
  // and the client rejects a tools/list result without them. The SDK client
  // of the other tests stops at an older version, so this test sends the
  // JSON-RPC itself.
  it("serves a 2026-07-28 client that skips initialize, with ttlMs and cacheScope on tools/list", async () => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
    };
    const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(new URL("/api/mcp", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          // SEP-2243: a tools/call names its tool in a header too.
          ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }),
      });
      expect(response.status, `${method}: ${response.status}`).toBe(200);
      const body = await response.json();
      expect(body.error, `${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
      return body.result;
    };

    const discover = await rpc(1, "server/discover");
    expect(discover.supportedVersions ?? discover.protocolVersions).toContain("2026-07-28");

    const list = await rpc(2, "tools/list");
    expect(list.tools.length).toBeGreaterThan(0);
    expect(typeof list.ttlMs).toBe("number");
    expect(list.ttlMs).toBeGreaterThanOrEqual(0);
    expect(["public", "private"]).toContain(list.cacheScope);

    const call = await rpc(3, "tools/call", { name: "list_books", arguments: {} });
    expect(call.isError).not.toBe(true);
  });

  it("refuses a request without a key, with a Bearer challenge", async () => {
    const response = await post({});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses an unknown key and a revoked key", async () => {
    expect((await post({ authorization: `Bearer ${generateApiKey()}` })).status).toBe(401);
    await exec("DELETE FROM api_keys");
    expect((await post({ authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it("refuses a session cookie", async () => {
    const token = randomBytes(32).toString("hex");
    await insert("sessions", {
      userId: 1,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect((await post({ cookie: `counterpoise_session=${token}` })).status).toBe(401);
  });

  it("refuses an Origin of another host", async () => {
    const host = new URL(baseUrl).host;
    expect((await post({ authorization: `Bearer ${key}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${key}`, origin: `http://${host}` })).status).toBe(200);
  });

  it("compares Origin with X-Forwarded-Host, which the Next rewrite sets", async () => {
    const forwarded = { authorization: `Bearer ${key}`, "x-forwarded-host": "books.example" };
    expect((await post({ ...forwarded, origin: "https://books.example" })).status).toBe(200);
    expect((await post({ ...forwarded, origin: "https://evil.example" })).status).toBe(403);
  });

  it("stops a tool call at once when the key is revoked", async () => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/api/mcp", baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      })
    );
    try {
      expect((await callMcpTool(client, "list_books")).isError).toBe(false);
      await exec("DELETE FROM api_keys");
      await expect(callMcpTool(client, "list_books")).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
