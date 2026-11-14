import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase } from "@/tests/helpers/db-utils";
import { startHttpTestServer, startHttpTestServerOn } from "@/tests/helpers/http-parity";

// THE TEST SERVER HELPER MUST NOT TAKE ANOTHER SERVER FOR ITS OWN. The helper
// chooses a free port and then starts the server on it. Another Vitest worker
// can bind that port in between. The other server then answers the readiness
// request. On 2026-11-10 a start accepted that answer, and its file sent
// every request to a Worker on another worker's database: four tests of
// tests/mcp/rust-transport.test.ts got 401 for a valid key.
describe("the test server on a port that another server holds", () => {
  let first: Awaited<ReturnType<typeof startHttpTestServer>>;

  beforeAll(async () => {
    await setupTestDatabase();
    first = await startHttpTestServer();
  }, 120_000);

  afterAll(async () => {
    await first.stop();
  });

  it("refuses the start, although the other server answers on the port", async () => {
    const port = Number(new URL(first.baseUrl).port);
    // `startHttpTestServer` reads this message to start again on a new port.
    await expect(startHttpTestServerOn(port)).rejects.toThrow(/Address already in use/);
    // The first server is not stopped by the refused start.
    expect((await fetch(`${first.baseUrl}/api/version`)).status).toBe(200);
  }, 120_000);
});
