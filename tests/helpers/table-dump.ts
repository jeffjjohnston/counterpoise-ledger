import { sql } from "drizzle-orm";
import { db } from "./db-utils";

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
  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.data_type not like 'timestamp%' and c.column_name <> 'password_hash'
    order by c.table_name, c.ordinal_position`);
  const tables = new Map<string, string[]>();
  for (const { table_name, column_name } of columns) {
    tables.set(table_name, [...(tables.get(table_name) ?? []), column_name]);
  }
  const rows: Record<string, unknown[]> = {};
  for (const [table, names] of tables) {
    const list = names.map((name) => `"${name}"`).join(", ");
    const order = ORDER_BY[table] ?? (names.includes("id") ? "id" : list);
    rows[table] = [...(await db.execute(sql.raw(`select ${list} from "${table}" order by ${order}`)))];
  }
  return rows;
}
