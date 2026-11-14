import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { setupTestDatabase } from "../helpers/db-utils";
import { onWorker, startHttpTestServer } from "../helpers/http-parity";
import { workerDatabasePath } from "../helpers/test-database";

/**
 * The alarms that workerd holds for the object. workerd keeps an alarm as a
 * row of `_cf_METADATA` in the object's own file, and makes the table at the
 * first alarm.
 */
function alarms(): number {
  const database = new DatabaseSync(workerDatabasePath(), { readOnly: true });
  try {
    const table = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_cf_METADATA'")
      .get();
    if (!table) return 0;
    const row = database.prepare("SELECT count(*) AS alarms FROM _cf_METADATA").get();
    return Number(row?.alarms);
  } finally {
    database.close();
  }
}

// The tests write to the object's file on a connection of their own. workerd
// does not wait for a lock, so an alarm that writes during a test's write
// fails with SQLITE_BUSY and logs an uncaught error. The requests of a test
// and its writes never overlap, but an alarm runs when a job is due. Thus the
// test Worker runs with no alarm, as the native test server runs with no
// scheduler.
describe.runIf(onWorker)("Worker alarm in the tests", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it("sets no alarm, so that no job writes during a test", async () => {
    await setupTestDatabase();
    ({ stop } = await startHttpTestServer());
    expect(alarms()).toBe(0);
  }, 120_000);

  it("sets the alarm when the scheduler is not off", async () => {
    await setupTestDatabase();
    ({ stop } = await startHttpTestServer({ COUNTERPOISE_SCHEDULER: "on" }));
    expect(alarms()).toBe(1);
  }, 120_000);
});
