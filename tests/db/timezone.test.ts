import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDatabase } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { toDateString } from "@/lib/formatters";

beforeAll(async () => {
  await setupTestDatabase();
});

/**
 * effectiveDateSql resolves "today" with CURRENT_DATE, which Postgres evaluates
 * in the session's timezone. The official postgres image hardcodes
 * `timezone = 'UTC'` in postgresql.conf and the TZ environment variable does not
 * change it — TZ only affects the OS clock and log timestamps.
 *
 * So without pinning the session timezone, SQL resolves today in UTC while every
 * JS path (toDateString, getEffectiveDate) uses local time. Floating
 * transactions then jump to tomorrow in balances, reports and ordering for the
 * hours between local evening and UTC midnight, and heal themselves by morning
 * — which is why three releases and a full review pass missed it.
 */
describe("database and application clocks", () => {
  it("runs SQL in the same timezone the Node process uses", async () => {
    // The invariant, asserted directly: true at every hour, unlike comparing
    // dates, which only diverges inside the offset window.
    const rows = await db.execute<{ tz: string }>(
      sql`select current_setting('TimeZone') as tz`
    );

    expect(rows[0].tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("agrees with the application on what day it is", async () => {
    const rows = await db.execute<{ today: string }>(
      sql`select current_date::text as today`
    );

    expect(rows[0].today).toBe(toDateString(new Date()));
  });
});
