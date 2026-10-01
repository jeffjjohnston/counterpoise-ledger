import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { rows } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/**
 * `request.json()` decodes the body as UTF-8 text before `JSON.parse`: it
 * removes up to two leading byte order marks (undici removes one, then its
 * TextDecoder removes one) and replaces each invalid sequence with U+FFFD.
 * `JSON.stringify` cannot write these bodies, so each one is bytes.
 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe("JSON request bodies as UTF-8 text", () => {
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

  async function createPayee(body: Buffer) {
    const response = await client.request("/api/b/1/payees", {
      method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it("removes up to two leading BOMs and replaces invalid UTF-8", async () => {
    const withBom = await createPayee(Buffer.concat([BOM, Buffer.from('{"name":"Cafe"}')]));
    expect(withBom.status).toBe(200);
    expect(withBom.body).toMatchObject({ name: "Cafe" });
    const withTwo = await createPayee(Buffer.concat([BOM, BOM, Buffer.from('{"name":"Deli"}')]));
    expect(withTwo.status).toBe(200);
    expect(withTwo.body).toMatchObject({ name: "Deli" });

    // A lone 0xFF, a truncated three-byte sequence, and a truncated four-byte
    // sequence: each is one replacement character.
    const invalid = Buffer.concat([
      Buffer.from('{"name":"A'), Buffer.from([0xff]), Buffer.from("B"), Buffer.from([0xe2, 0x82]),
      Buffer.from("C"), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from('"}'),
    ]);
    const replaced = await createPayee(invalid);
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: "A\uFFFDB\uFFFDC\uFFFD" });

    expect((await rows<{ name: string }>("SELECT name FROM payees ORDER BY id")).map((row) => row.name))
      .toEqual(["Cafe", "Deli", "A\uFFFDB\uFFFDC\uFFFD"]);
  });

  it("refuses a third BOM and a BOM after whitespace as malformed JSON", async () => {
    for (const body of [
      Buffer.concat([BOM, BOM, BOM, Buffer.from('{"name":"Cafe"}')]),
      Buffer.concat([Buffer.from(" "), BOM, Buffer.from('{"name":"Cafe"}')]),
    ]) {
      expect(await createPayee(body)).toEqual({ status: 500, body: { error: "Failed to create payee" } });
    }
    expect(await rows("SELECT * FROM payees")).toEqual([]);
  });
});
