import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPayee, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/**
 * Response compression (rust-api/server/src/compression.rs), sent to the real
 * binary. The unit tests in that file hold the rules. This case proves that
 * `serve()` puts the layer around the routes.
 *
 * `fetch` removes the encoding from the body, but it keeps the
 * `Content-Encoding` header, so the header tells what the server sent.
 */
describe("response compression HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => { await stop?.(); });

  it("compresses a large JSON response only when the client accepts an encoding", async () => {
    for (let index = 0; index < 40; index++) await createPayee({ name: `Payee ${index}` });

    const plain = await client.request("/api/b/1/payees", { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-encoding")).toBeNull();
    const text = await plain.text();
    expect(text.length).toBeGreaterThan(1000);
    expect(plain.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));

    for (const [accept, encoding] of [["gzip", "gzip"], ["gzip, deflate, br, zstd", "br"]]) {
      const response = await client.request("/api/b/1/payees", { headers: { "accept-encoding": accept } });
      expect(response.status, accept).toBe(200);
      expect(response.headers.get("content-encoding"), accept).toBe(encoding);
      expect(response.headers.get("vary"), accept).toBe("accept-encoding");
      expect(response.headers.get("content-length"), accept).toBeNull();
      expect(await response.text(), accept).toBe(text);
    }
  });
});
