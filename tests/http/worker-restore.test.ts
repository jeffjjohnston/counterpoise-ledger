import { afterEach, describe, expect, it } from "vitest";
import { setupTestDatabase } from "../helpers/db-utils";
import { hasExportsObject, onWorker, putExportsObject, startHttpTestServer } from "../helpers/http-parity";
import { scalar } from "../helpers/sql";

/** The key of the restore marker (`MARKER` in `rust-api/server/src/hosted/restore.rs`). */
const MARKER = "restore-pending";

/** The number of floor markers in the change log. */
const floors = async () =>
  Number(await scalar("SELECT count(*) FROM transaction_changes WHERE book_id = 0"));

// The object asks the export bucket for the restore marker when it is
// constructed, and no event uses the server before the answer is handled
// (`finish_restore` in `rust-api/worker/src/object.rs`). A local run cannot
// do a point-in-time restore, so these tests put the marker in the local
// bucket, as `schedule_restore` does before the object resets.
describe.runIf(onWorker)("Worker restore marker at the start", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it("serves a start with no marker and adds no floor marker", async () => {
    await setupTestDatabase();
    expect(hasExportsObject(MARKER)).toBe(false);
    const before = await floors();
    let baseUrl: string;
    ({ baseUrl, stop } = await startHttpTestServer({}, { exports: true }));
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${baseUrl}/api/version`))
    );
    expect(answers.map((answer) => answer.status)).toEqual(Array(8).fill(200));
    expect(await floors()).toBe(before);
  }, 120_000);

  it("finishes a restore before the first event is served, one time", async () => {
    await setupTestDatabase();
    putExportsObject(MARKER, JSON.stringify({ request: "test", bookmark: "test" }));
    expect(hasExportsObject(MARKER)).toBe(true);
    const before = await floors();

    // The request that shows the server as ready is the first event.
    let baseUrl: string;
    ({ baseUrl, stop } = await startHttpTestServer({}, { exports: true }));
    expect(await floors()).toBe(before + 1);
    expect(hasExportsObject(MARKER)).toBe(false);
    expect((await fetch(`${baseUrl}/api/version`)).status).toBe(200);
    await stop();

    // The marker is gone, so the next start adds no floor marker.
    ({ baseUrl, stop } = await startHttpTestServer({}, { exports: true }));
    expect((await fetch(`${baseUrl}/api/version`)).status).toBe(200);
    expect(await floors()).toBe(before + 1);
  }, 240_000);

  // workerd removes an idle object from memory after 10 seconds, and the next
  // request constructs it again. Thus the 8 requests after each wait are the
  // first events of a new instance, and they arrive together.
  it("holds the first events of a new instance until the marker is handled", async () => {
    await setupTestDatabase();
    const before = await floors();
    let baseUrl: string;
    ({ baseUrl, stop } = await startHttpTestServer({}, { exports: true }));
    const idle = () => new Promise((resolve) => setTimeout(resolve, 15_000));
    const together = async () => {
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => fetch(`${baseUrl}/api/version`))
      );
      return answers.map((answer) => answer.status);
    };

    await idle();
    expect(await together()).toEqual(Array(8).fill(200));
    expect(await floors()).toBe(before);

    // The floor marker shows that the wait is long enough: only the start of
    // a new instance looks for the restore marker.
    putExportsObject(MARKER, JSON.stringify({ request: "test", bookmark: "test" }));
    await idle();
    expect(await together()).toEqual(Array(8).fill(200));
    expect(await floors()).toBe(before + 1);
    expect(hasExportsObject(MARKER)).toBe(false);
  }, 240_000);

  // The local storage has no point-in-time recovery, so it refuses each
  // bookmark. `schedule_restore` put the marker before it asked the storage.
  it("leaves no marker and adds no floor marker when the storage refuses a restore", async () => {
    await setupTestDatabase();
    const before = await floors();
    let baseUrl: string;
    ({ baseUrl, stop } = await startHttpTestServer({ IMPORT_SECRET: "restore-test-secret" }, { exports: true }));
    const refused = await fetch(`${baseUrl}/api/admin/restore`, {
      method: "POST",
      headers: { authorization: "Bearer restore-test-secret", "content-type": "application/json" },
      body: JSON.stringify({ bookmark: "test" }),
    });
    expect(refused.status).toBe(400);
    expect(hasExportsObject(MARKER)).toBe(false);
    expect((await fetch(`${baseUrl}/api/version`)).status).toBe(200);
    await stop();

    ({ baseUrl, stop } = await startHttpTestServer({}, { exports: true }));
    expect((await fetch(`${baseUrl}/api/version`)).status).toBe(200);
    expect(await floors()).toBe(before);
  }, 240_000);
});
