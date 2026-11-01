import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { onWorker, startHttpTestServer } from "../helpers/http-parity";

const MIB = 1024 * 1024;
/** The route limits of `hosted::body_limit`. */
const ORDINARY = 2 * MIB;
const MCP = 4 * MIB;
const IMPORT_SECRET = "test-import-secret";

type Sent = { status: number; body: string };

/**
 * Sends a POST of `size` bytes in 64 KiB pieces with node:http, so that the
 * test controls `Content-Length`: `declared` sets it (it may differ from
 * `size`), and `undefined` sends the body chunked. The answer can come
 * before the body is sent; the whole body is sent anyway, as a client that
 * does not read the answer early would, so that no refusal here is a
 * dropped connection.
 */
function send(
  baseUrl: string,
  path: string,
  size: number,
  options: { declared?: number; headers?: OutgoingHttpHeaders } = {}
): Promise<Sent> {
  const url = new URL(path, baseUrl);
  const headers: OutgoingHttpHeaders = { "content-type": "application/json", ...options.headers };
  if (options.declared !== undefined) headers["content-length"] = String(options.declared);
  return new Promise((resolve, reject) => {
    let answered = false;
    // A connection of its own for each request.
    const request = httpRequest(url, { method: "POST", headers, agent: false }, (response) => {
      answered = true;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on("error", (cause) => { if (!answered) reject(cause); });
    const piece = Buffer.alloc(64 * 1024, "a");
    let sent = 0;
    const write = () => {
      while (sent < size) {
        const next = piece.subarray(0, Math.min(piece.length, size - sent));
        sent += next.length;
        if (!request.write(next)) {
          request.once("drain", write);
          return;
        }
      }
      request.end();
    };
    write();
  });
}

/** Opens a POST that declares `declared` bytes, sends `sent` of them, and drops the connection. */
function abandon(baseUrl: string, path: string, declared: number, sent: number): Promise<void> {
  return new Promise((resolve) => {
    const request = httpRequest(new URL(path, baseUrl), {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(declared) },
    });
    request.on("error", () => {});
    request.write(Buffer.alloc(sent, "a"), () => {
      setTimeout(() => { request.destroy(); resolve(); }, 100);
    });
  });
}

// The Worker reads each body before the object checks a credential, so it
// bounds that read itself (`worker_entry.rs`). The native server reads a body
// only in the route, so these are the Worker's.
describe.runIf(onWorker)("Worker request body limits", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let output: () => string;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop, output } = await startHttpTestServer({ IMPORT_SECRET }));
  }, 120_000);
  beforeEach(resetTestDatabase);
  afterAll(async () => { await stop?.(); });

  it("refuses an oversized declared length without a credential", async () => {
    const refused = await send(baseUrl, "/api/mcp", 5 * MIB, { declared: 5 * MIB });
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toEqual({ error: `Payload Too Large: request body exceeds ${MCP} bytes` });
    const ordinary = await send(baseUrl, "/api/auth/login", ORDINARY + 1, { declared: ORDINARY + 1 });
    expect(ordinary.status).toBe(413);
  });

  it("refuses a chunked body once it passes the limit", async () => {
    const refused = await send(baseUrl, "/api/mcp", 8 * MIB);
    expect(refused.status).toBe(413);
    const ordinary = await send(baseUrl, "/api/oauth/token", 4 * MIB);
    expect(ordinary.status).toBe(413);
  });

  it("forwards a body at the limit and refuses one byte more", async () => {
    // At the limit the body reaches the route, which refuses the missing credential.
    for (const declared of [MCP, undefined]) {
      const atLimit = await send(baseUrl, "/api/mcp", MCP, { declared });
      expect(atLimit.status, `declared ${declared}`).toBe(401);
      const over = await send(baseUrl, "/api/mcp", MCP + 1, { declared: declared && declared + 1 });
      expect(over.status, `declared ${declared}`).toBe(413);
    }
    // An ordinary route without a session: past the Worker, the object refuses the request.
    const atLimit = await send(baseUrl, "/api/b/1/accounts", ORDINARY, { declared: ORDINARY });
    expect(atLimit.status, atLimit.body).toBe(401);
    const over = await send(baseUrl, "/api/b/1/accounts", ORDINARY + 1);
    expect(over.status).toBe(413);
  });

  it("gives the import its larger limit only with the secret", async () => {
    const size = 3 * MIB;
    const anonymous = await send(baseUrl, "/api/admin/import", size, { declared: size });
    expect(anonymous.status).toBe(413);
    const wrong = await send(baseUrl, "/api/admin/import", size, {
      declared: size, headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(413);
    const authorized = { authorization: `Bearer ${IMPORT_SECRET}` };
    // The test object holds a user, so the route refuses the dump: it got past the Worker.
    const imported = await send(baseUrl, "/api/admin/import", size, { declared: size, headers: authorized });
    expect(imported.status).not.toBe(413);
    expect([400, 409]).toContain(imported.status);
    const chunked = await send(baseUrl, "/api/admin/import", 1024, { headers: authorized });
    expect(chunked.status).toBe(411);
  });

  // Before the test below, whose abandoned requests the dev server logs.
  it("leaves no uncaught error behind a refusal", () => {
    expect(output()).not.toMatch(/uncaught|Network connection lost|SQLITE/i);
  });

  it("keeps serving after a client abandons its body", async () => {
    await abandon(baseUrl, "/api/auth/login", MIB, 64 * 1024);
    await abandon(baseUrl, "/api/mcp", 5 * MIB, 1);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "testuser", password: "wrong" }),
    });
    expect(login.status).toBe(401);
  });

});
