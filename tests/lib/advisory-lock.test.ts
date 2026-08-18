import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { getDb } from "@/db";
import { payees } from "@/db/schema";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

/** Well clear of any real (accountId, securityId) or token id. */
const TEST_NAMESPACE = 999_001;

describe("withAdvisoryLock", () => {
  beforeAll(async () => {
    await setupTestDatabase();
    // The rollback test writes a payee, which needs book 1 to exist.
    await resetTestDatabase();
  });

  it("gives the guarded work a connection instead of competing for one", async () => {
    // The lock pins one pooled connection for as long as it is held. If the
    // guarded work then reaches for a SECOND connection, enough concurrent
    // holders reserve every connection in the pool and none of them can ever
    // get the one they still need — a deadlock that also starves unrelated
    // requests. Running the work on the reserved connection caps each holder at
    // one connection, so exceeding the pool size merely queues.
    const HOLDERS = 12; // pool max is 10

    const work = Promise.all(
      Array.from({ length: HOLDERS }, (_, index) =>
        withAdvisoryLock(TEST_NAMESPACE, 8_000 + index, async (db) => {
          const rows = await db.execute(sql`select 1 as ok`);
          return rows.length;
        })
      )
    );

    const results = await Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out: advisory-lock holders starved the pool")),
          10_000
        )
      ),
    ]);

    expect(results).toHaveLength(HOLDERS);
    for (const result of results) {
      expect(result.acquired).toBe(true);
    }
  }, 20_000);

  it("reports contention rather than waiting for the holder", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = withAdvisoryLock(TEST_NAMESPACE, 7_001, async () => {
      await held;
      return "first";
    });

    // Give the holder time to take the lock before the second attempt.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const contender = await withAdvisoryLock(TEST_NAMESPACE, 7_001, async () => "second");
    expect(contender.acquired).toBe(false);

    release();
    expect(await holder).toEqual({ acquired: true, value: "first" });
  });

  it("releases the lock so a later caller can take it", async () => {
    const first = await withAdvisoryLock(TEST_NAMESPACE, 7_002, async () => "a");
    expect(first.acquired).toBe(true);

    const second = await withAdvisoryLock(TEST_NAMESPACE, 7_002, async () => "b");
    expect(second).toEqual({ acquired: true, value: "b" });
  });

  it("gives the guarded work a db that can open a transaction", async () => {
    // The guarded work gets a Drizzle instance bound to a reserved connection,
    // and postgres.js gives reserved connections no `begin` — so an unpatched
    // one fails `db.transaction(...)` with "this.client.begin is not a
    // function". lib/plaid-auto-match.ts claims each row in a transaction, so
    // that gap silently disabled every Plaid auto-match.
    const result = await withAdvisoryLock(TEST_NAMESPACE, 7_004, (db) =>
      db.transaction(async (tx) => {
        const rows = await tx.execute<{ ok: number }>(sql`select 1 as ok`);
        return rows.length;
      })
    );

    expect(result).toEqual({ acquired: true, value: 1 });
  });

  it("rolls a failed transaction back without poisoning the connection", async () => {
    await expect(
      withAdvisoryLock(TEST_NAMESPACE, 7_005, (db) =>
        db.transaction(async (tx) => {
          await tx.insert(payees).values({ bookId: 1, name: "Rollback Probe" });
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");

    const survivors = await getDb()
      .select()
      .from(payees)
      .where(eq(payees.name, "Rollback Probe"));
    expect(survivors).toHaveLength(0);

    // The connection goes back to the pool afterwards. A transaction left open
    // or aborted would fail every later user of it with "current transaction is
    // aborted", so this recovery is as much the point as the rollback itself.
    const after = await withAdvisoryLock(TEST_NAMESPACE, 7_005, async (db) => {
      const rows = await db.execute(sql`select 1 as ok`);
      return rows.length;
    });

    expect(after).toEqual({ acquired: true, value: 1 });
  });

  it("nests transactions without discarding the outer one", async () => {
    // Drizzle implements a nested transaction as client.savepoint(), which a
    // reserved connection lacks for the same reason it lacks begin. Getting
    // this wrong is worse than failing outright: a savepoint rollback that
    // reached too far would silently drop the outer transaction's writes.
    const result = await withAdvisoryLock(TEST_NAMESPACE, 7_006, (db) =>
      db.transaction(async (tx) => {
        await tx.insert(payees).values({ bookId: 1, name: "Outer Payee" });

        await expect(
          tx.transaction(async (inner) => {
            await inner.insert(payees).values({ bookId: 1, name: "Inner Payee" });
            throw new Error("inner boom");
          })
        ).rejects.toThrow("inner boom");

        return "outer committed";
      })
    );

    expect(result).toEqual({ acquired: true, value: "outer committed" });

    const names = (await getDb().select().from(payees)).map((payee) => payee.name);
    expect(names).toContain("Outer Payee");
    expect(names).not.toContain("Inner Payee");
  });

  it("releases the lock when the guarded work throws", async () => {
    await expect(
      withAdvisoryLock(TEST_NAMESPACE, 7_003, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const after = await withAdvisoryLock(TEST_NAMESPACE, 7_003, async () => "recovered");
    expect(after).toEqual({ acquired: true, value: "recovered" });
  });
});
