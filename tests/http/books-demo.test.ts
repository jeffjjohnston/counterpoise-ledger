import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createBook, createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { count as countWhere, row, rows, script } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

const bookSchema = contract("Book");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

// The seed writes thousands of rows, so each creation takes seconds.
const SEED_TIMEOUT = 120_000;

async function count(table: string, bookId: number) {
  return countWhere(table, "book_id = $1", [bookId]);
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

  const createDemoWith = (body: string) =>
    client.request("/api/books/demo", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });

  it("lists the datasets for a session", async () => {
    expect((await client.anonymous("/api/books/demo/datasets")).status).toBe(401);
    const response = await client.request("/api/books/demo/datasets");
    expect(response.status).toBe(200);
    const datasets = await response.json() as { id: string; name: string; description: string }[];
    expect(datasets.map((d) => d.id)).toEqual(["household", "single"]);
    for (const dataset of datasets) {
      expect(dataset.name.length).toBeGreaterThan(0);
      expect(dataset.description.length).toBeGreaterThan(0);
    }
  });

  it("creates the single dataset and numbers its name", async () => {
    const first = await createDemoWith(JSON.stringify({ dataset: "single" }));
    expect(first.status).toBe(200);
    const book = bookSchema.parse(await first.json());
    expect(book.name).toBe("Demo Book - Single");
    expect(await countWhere("accounts", "book_id = $1 AND name = $2", [book.id, "Mortgage"])).toBe(1);
    expect(await count("recurring_rules", book.id)).toBe(7);

    const second = await createDemoWith(JSON.stringify({ dataset: "single" }));
    expect(bookSchema.parse(await second.json()).name).toBe("Demo Book - Single 2");
  }, SEED_TIMEOUT);

  it("treats an empty object as the household dataset", async () => {
    const response = await createDemoWith("{}");
    expect(response.status).toBe(200);
    expect(bookSchema.parse(await response.json()).name).toBe("Demo Book");
  }, SEED_TIMEOUT);

  it("refuses a body that does not name a dataset, and creates no book", async () => {
    for (const [body, message] of [
      ['{"dataset":"nope"}', 'Unknown dataset "nope". Use one of: household, single'],
      ['{"dataset":"SINGLE"}', 'Unknown dataset "SINGLE". Use one of: household, single'],
      ['{"dataset":3}', "dataset must be a string"],
      ["null", "Request body must be a JSON object"],
      ["[]", "Request body must be a JSON object"],
      ['"single"', "Request body must be a JSON object"],
      ["{not json", "Invalid JSON body"],
    ]) {
      const response = await createDemoWith(body);
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: message });
    }
    expect(await rows("SELECT id FROM books")).toHaveLength(1);
  });

  it("refuses a request without a valid session", async () => {
    expect((await client.anonymous("/api/books/demo", { method: "POST" })).status).toBe(401);
    // A cookie gets past the Node proxy, so the handler itself refuses it.
    const expired = await client.anonymous("/api/books/demo", {
      method: "POST", headers: { cookie: "counterpoise_session=expired" },
    });
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({ error: "Not authenticated" });
    expect(await rows("SELECT id FROM books")).toHaveLength(1);
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

    const member = await row<{ role: string }>(
      "SELECT role FROM book_members WHERE book_id = $1 AND user_id = $2", [book.id, 1]
    );
    expect(member.role).toBe("owner");
    expect(await count("accounts", book.id)).toBe(62);
    // The window ends today, so the count depends on the day of the month.
    expect(await count("transactions", book.id)).toBeGreaterThan(2000);
    expect(await count("investment_lots", book.id)).toBeGreaterThan(0);
    expect(await count("accounts", bystander.id)).toBe(1);

    // The rules are scheduled from today in the server's zone.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const rules = await rows<{ nextDate: string }>(
      "SELECT next_date FROM recurring_rules WHERE book_id = $1", [book.id]
    );
    expect(rules).toHaveLength(6);
    for (const rule of rules) expect(rule.nextDate > today).toBe(true);

    // The dates end today: this month has rows, and nothing is later.
    const monthStart = `${today.slice(0, 8)}01`;
    expect(await countWhere("transactions", "book_id = $1 AND date >= $2", [book.id, monthStart]))
      .toBeGreaterThan(0);
    expect(await countWhere("transactions", "book_id = $1 AND date > $2", [book.id, today])).toBe(0);
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
    // The window ends today, so the count depends on the day of the month.
    expect(await count("transactions", thirdBook.id)).toBeGreaterThan(2000);
  }, SEED_TIMEOUT);

  it("leaves no book behind when the seed fails", async () => {
    // The Plaid rows come after every transaction, so this trigger fails the
    // seed late in the run.
    await script(`CREATE TRIGGER refuse_demo_token BEFORE INSERT ON plaid_tokens
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    try {
      const response = await createDemo();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Failed to create demo book" });
    } finally {
      await script("DROP TRIGGER IF EXISTS refuse_demo_token");
    }
    expect(await rows("SELECT id FROM books")).toHaveLength(1);
    expect(await rows("SELECT id FROM accounts")).toHaveLength(0);
  }, SEED_TIMEOUT);
});
