import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getLatestPrices } from "@/lib/investments";
import {
  createBook,
  createSecurity,
  createSecurityPrice,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { toDateString } from "@/lib/formatters";

/**
 * security_prices grows by roughly 250 rows per security per year, and both
 * getPositions and getMarketValuesByAccount only ever want the newest row per
 * security. Collapsing that in SQL rather than loading the whole table and
 * reducing it in JS is the point of this helper, so the test asserts the row
 * count as well as the values — a correct latest-price map built from every row
 * in the book would pass a values-only assertion.
 */
describe("getLatestPrices", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns exactly one row per security, the newest by price date", async () => {
    const vti = await createSecurity({ name: "Vanguard Total Market", symbol: "VTI", securityType: "etf" });
    const bnd = await createSecurity({ name: "Vanguard Total Bond", symbol: "BND", securityType: "etf" });

    // Deliberately inserted out of date order — the newest must win on
    // price_date, not on insertion order.
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-01-15", priceMicros: 100_000_000 });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-03-20", priceMicros: 130_000_000 });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-02-10", priceMicros: 110_000_000 });
    await createSecurityPrice({ securityId: bnd.id, priceDate: "2026-02-01", priceMicros: 70_000_000 });
    await createSecurityPrice({ securityId: bnd.id, priceDate: "2026-01-05", priceMicros: 60_000_000 });

    const rows = await getLatestPrices(db, 1);

    expect(rows).toHaveLength(2);
    expect([...rows].sort((a, b) => a.securityId - b.securityId)).toEqual([
      { securityId: vti.id, priceDate: "2026-03-20", priceMicros: 130_000_000 },
      { securityId: bnd.id, priceDate: "2026-02-01", priceMicros: 70_000_000 },
    ]);
  });

  it("returns nothing for a book with no prices", async () => {
    await createSecurity({ name: "Unpriced", symbol: "NONE", securityType: "stock" });
    expect(await getLatestPrices(db, 1)).toEqual([]);
  });

  it("does not leak prices from another book", async () => {
    await createBook({ name: "Other Book" });
    const mine = await createSecurity({ name: "Mine", symbol: "MINE", securityType: "etf" });
    await createSecurityPrice({ securityId: mine.id, priceDate: "2026-03-01", priceMicros: 50_000_000 });
    // Same security, a row misattributed to another book: book scoping has to
    // come from the predicate, not from the security's ownership.
    await createSecurityPrice({
      securityId: mine.id,
      priceDate: "2026-03-02",
      priceMicros: 99_000_000,
      bookId: 2,
    });

    const rows = await getLatestPrices(db, 1);

    expect(rows).toEqual([
      { securityId: mine.id, priceDate: "2026-03-01", priceMicros: 50_000_000 },
    ]);
  });

  /**
   * A fixed-price security (a money market fund at a $1.00 NAV) carries its
   * price on the securities row itself. It is never fetched and never prompted
   * for, so security_prices holds nothing current for it — the fixed price has
   * to be synthesized here, which is what lets every caller of getPositions and
   * getMarketValuesByAccount value the position without knowing the rule.
   */
  it("reports a fixed-price security at its fixed price, dated today", async () => {
    const mmf = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
    });

    const rows = await getLatestPrices(db, 1);

    expect(rows).toEqual([
      {
        securityId: mmf.id,
        priceDate: toDateString(new Date()),
        priceMicros: 1_000_000,
      },
    ]);
  });

  it("prefers a security's fixed price over its stored price rows", async () => {
    // Prices recorded before the security was marked fixed-price. They stay on
    // the books as a record, but they must not value the position.
    const mmf = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
    });
    await createSecurityPrice({ securityId: mmf.id, priceDate: "2026-03-20", priceMicros: 999_000 });

    const rows = await getLatestPrices(db, 1);

    expect(rows).toEqual([
      {
        securityId: mmf.id,
        priceDate: toDateString(new Date()),
        priceMicros: 1_000_000,
      },
    ]);
  });
});
