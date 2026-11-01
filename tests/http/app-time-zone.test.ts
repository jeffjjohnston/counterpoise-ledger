import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, createTransactionWithSplits, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/** The date of `instant` in `zone`, as YYYY-MM-DD. */
function dateIn(zone: string, instant = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// Kiritimati is UTC+14 and Pago Pago UTC-11, so the two zones never share a
// date: today's date shows which zone the server used.
const APP_ZONE = "Pacific/Kiritimati";
const TZ_ZONE = "Pacific/Pago_Pago";

describe("the app's time zone", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ APP_TZ: APP_ZONE, TZ: TZ_ZONE }));
  }, 120_000);
  afterAll(async () => { await stop?.(); });

  it("dates a floating transaction today in APP_TZ, not in TZ", async () => {
    await resetTestDatabase();
    const client = await sessionHttpClient(baseUrl);
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-12-01", description: "Floating check", isFloating: true,
      splits: [{ accountId: checking.id, amount: -700 }, { accountId: groceries.id, amount: 700 }],
    });
    // The register filters by the effective date: today for a floating row.
    const count = async (date: string) => {
      const response = await client.request(`/api/b/1/transactions?accountId=${checking.id}&startDate=${date}&endDate=${date}`);
      expect(response.status).toBe(200);
      return ((await response.json()) as unknown[]).length;
    };
    const before = dateIn(APP_ZONE);
    const appDay = await count(before);
    const appDayAgain = before === dateIn(APP_ZONE) ? appDay : await count(dateIn(APP_ZONE));
    expect(appDay + appDayAgain).toBeGreaterThan(0);
    expect(await count(dateIn(TZ_ZONE))).toBe(0);
  });

  it("refuses to start on a zone name it does not know", async () => {
    await expect(startHttpTestServer({ APP_TZ: "Mars/Olympus_Mons" })).rejects.toThrow(/APP_TZ=Mars\/Olympus_Mons/);
  }, 120_000);
});
