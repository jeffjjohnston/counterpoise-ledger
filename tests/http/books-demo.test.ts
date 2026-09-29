import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createBook, createUser, db, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

const bookSchema = contract("Book");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

// The seed writes thousands of rows, so each creation takes seconds.
const SEED_TIMEOUT = 120_000;

async function count(table: string, bookId: number) {
  const [row] = await db.execute<{ count: number }>(
    sql.raw(`select cast(count(*) as integer) as count from "${table}" where book_id = ${bookId}`)
  );
  return row.count;
}

describe("demo book HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ: "America/New_York" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  const createDemo = () => client.request("/api/books/demo", { method: "POST" });

  it("refuses a request without a valid session", async () => {
    expect((await client.anonymous("/api/books/demo", { method: "POST" })).status).toBe(401);
    // A cookie gets past the Node proxy, so the handler itself refuses it.
    const expired = await client.anonymous("/api/books/demo", {
      method: "POST", headers: { cookie: "counterpoise_session=expired" },
    });
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({ error: "Not authenticated" });
    expect(await db.execute(sql`select id from books`)).toHaveLength(1);
  });

  it("creates a book owned by the session user, fills it, and leaves other books alone", async () => {
    const other = await createUser({ username: "other-user" });
    const bystander = await createBook({ name: "Other User Book", userId: other.id });
    await createAccount({ bookId: bystander.id, name: "Untouchable", type: "asset" });

    const response = await createDemo();
    expect(response.status).toBe(200);
    const book = bookSchema.parse(await response.json());
    expect(book).toMatchObject({ name: "Demo Book", userId: 1, upcomingDays: 30 });
    expect(book.role).toBeUndefined();

    const [member] = await db.execute<{ role: string }>(
      sql`select role from book_members where book_id = ${book.id} and user_id = 1`
    );
    expect(member.role).toBe("owner");
    expect(await count("accounts", book.id)).toBe(62);
    expect(await count("transactions", book.id)).toBe(2235);
    expect(await count("investment_lots", book.id)).toBeGreaterThan(0);
    expect(await count("accounts", bystander.id)).toBe(1);

    // The rules are scheduled from today in the server's zone.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const rules = await db.execute<{ next_date: string }>(
      sql`select next_date from recurring_rules where book_id = ${book.id}`
    );
    expect(rules).toHaveLength(6);
    for (const rule of rules) expect(rule.next_date > today).toBe(true);
  }, SEED_TIMEOUT);

  it("gives each demo book a free name and its own Plaid identifiers", async () => {
    await createBook({ name: "Demo Book" });

    const second = await createDemo();
    expect(second.status).toBe(200);
    const secondBook = bookSchema.parse(await second.json());
    expect(secondBook.name).toBe("Demo Book 2");

    // Plaid item and account IDs are unique across all books.
    const third = await createDemo();
    expect(third.status).toBe(200);
    const thirdBook = bookSchema.parse(await third.json());
    expect(thirdBook.name).toBe("Demo Book 3");
    expect(await count("transactions", thirdBook.id)).toBe(2235);
  }, SEED_TIMEOUT);

  it("leaves no book behind when the seed fails", async () => {
    await db.execute(sql.raw(`
      create function refuse_demo_token() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$;
      create trigger refuse_demo_token before insert on plaid_tokens
        for each row execute function refuse_demo_token();`));
    try {
      const response = await createDemo();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Failed to create demo book" });
    } finally {
      await db.execute(sql.raw(`
        drop trigger refuse_demo_token on plaid_tokens;
        drop function refuse_demo_token();`));
    }
    expect(await db.execute(sql`select id from books`)).toHaveLength(1);
    expect(await db.execute(sql`select id from accounts`)).toHaveLength(0);
  }, SEED_TIMEOUT);
});
