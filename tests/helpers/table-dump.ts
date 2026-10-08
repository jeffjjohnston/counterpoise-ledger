import { rows, tableColumns } from "./sql";

/** The row order of each table that has no serial id. */
const ORDER_BY: Record<string, string> = {
  security_prices: "security_id, price_date",
  book_members: "book_id, user_id",
};

/**
 * Every row of every table, in insertion order. Timestamps are left out,
 * because each run writes its own clock. Password hashes are left out,
 * because each hash has a random salt. The parity tests compare a dump after
 * a TypeScript run with a dump after a Rust run. resetTestDatabase restarts
 * each sequence, so the serial IDs must agree too.
 */
export async function dumpTables() {
  const tables = new Map<string, string[]>();
  for (const { table, column, timestamp } of await tableColumns()) {
    // change_marks counts every row change for the live-update hints. It is
    // not data, and each write moves it, also a write that changes nothing.
    // transaction_changes logs each row change for the delta sync, for the
    // same reason.
    if (table === "change_marks" || table === "transaction_changes") continue;
    if (timestamp || column === "password_hash") continue;
    tables.set(table, [...(tables.get(table) ?? []), column]);
  }
  const dump: Record<string, unknown[]> = {};
  for (const [table, names] of tables) {
    const list = names.map((name) => `"${name}"`).join(", ");
    const order = ORDER_BY[table] ?? (names.includes("id") ? "id" : list);
    dump[table] = await rows(`SELECT ${list} FROM "${table}" ORDER BY ${order}`);
  }
  return dump;
}
