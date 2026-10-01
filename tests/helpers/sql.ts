/**
 * Raw SQL for test fixtures and assertions, on the SQLite file of this
 * Vitest worker. The tests use this module and never an ORM.
 *
 * - Parameters are `$1`, `$2`, ... in the SQL text, as in the Rust code.
 * - A `Date` parameter is written as a naive UTC timestamp, as the Rust code
 *   writes it. A boolean is written as 0 or 1, an object as JSON text.
 * - Every row comes back with camelCase keys. A column named `*_at` becomes a
 *   `Date`, a flag column a boolean, a micros column a number, and a JSON
 *   column a parsed value. Do not alias a result column to one of those names
 *   unless it holds that kind of value.
 *
 * The file is the one that `DATABASE_PATH` names; tests/setup.ts sets it to
 * the worker's file. A process that is not a Vitest worker, such as the
 * Playwright setup, calls `setDatabasePath` first.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, unknown>;

const BOOLEAN_COLUMNS = new Set([
  "is_active", "is_favorite", "is_investment_cash", "typesafe_reconciliation_enabled",
  "suggestion_visible", "accepted_suggestion", "proposal_payee_kept", "proposal_category_kept",
  "is_reconciled", "is_floating", "fetch_prices", "business_days_only", "is_demo", "pending",
]);
const BIGINT_COLUMNS = new Set([
  "shares_micros", "price_micros", "fixed_price_micros", "original_shares_micros",
  "remaining_shares_micros",
]);
const JSON_COLUMNS = new Set(["snapshot", "probabilities", "confidence", "usage", "answers", "counts"]);

/** The columns that the application fills with the time of the insert. */
const NOW_COLUMNS: Record<string, string[]> = {
  users: ["created_at"],
  sessions: ["created_at"],
  api_keys: ["created_at"],
  books: ["created_at", "updated_at"],
  book_members: ["created_at"],
  issue_reports: ["created_at"],
  accounts: ["created_at", "updated_at"],
  payees: ["created_at"],
  transactions: ["created_at", "updated_at"],
  securities: ["created_at"],
  investment_lots: ["created_at"],
  recurring_rules: ["created_at"],
  plaid_tokens: ["created_at", "updated_at"],
  plaid_accounts: ["created_at", "updated_at"],
  plaid_transaction_reconciliation: ["first_seen_at", "last_seen_at", "created_at", "updated_at"],
  typesafe_evaluations: ["started_at"],
  typesafe_decisions: ["decided_at"],
};

let database: DatabaseSync | undefined;
let databasePath: string | undefined;
let explicitPath: string | undefined;

/** Use the file at `path` instead of `DATABASE_PATH`. */
export function setDatabasePath(path: string): void {
  explicitPath = path;
}

function connection(): DatabaseSync {
  const path = explicitPath ?? process.env.DATABASE_PATH;
  if (!path) throw new Error("DATABASE_PATH is unset; tests/setup.ts sets it for each worker");
  if (!database || databasePath !== path) {
    database?.close();
    database = new DatabaseSync(path);
    // As the Rust connections: the server writes at the same time.
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    databasePath = path;
  }
  return database;
}

/** Closes the connection of this process. */
export async function closeSql(): Promise<void> {
  database?.close();
  database = undefined;
}

export function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/** `2026-09-28 12:34:56.789` in UTC: how a naive timestamp column holds an instant. */
export function naiveUtc(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function fromNaiveUtc(text: string): Date {
  return new Date(`${text.replace(" ", "T")}Z`);
}

function parameter(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return naiveUtc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as SQLInputValue;
}

function convert(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.endsWith("_at") && typeof value === "string") return fromNaiveUtc(value);
  if (BOOLEAN_COLUMNS.has(column) && typeof value !== "boolean") return Boolean(Number(value));
  if (BIGINT_COLUMNS.has(column) && typeof value !== "number") return Number(value);
  if (JSON_COLUMNS.has(column) && typeof value === "string") return JSON.parse(value);
  return value;
}

/** A row with camelCase keys and converted values. */
export function toRow<T = Row>(raw: Record<string, unknown>): T {
  const row: Row = {};
  for (const [column, value] of Object.entries(raw)) row[camelCase(column)] = convert(column, value);
  return row as T;
}

/** `$1` becomes `?1`: SQLite binds a numbered parameter by its position. */
function statement(text: string) {
  return connection().prepare(text.replace(/\$(\d+)/g, "?$1"));
}

function run(text: string, params: unknown[]): { rows: Record<string, unknown>[]; count: number } {
  const prepared = statement(text);
  const values = params.map(parameter);
  if (prepared.columns().length > 0) {
    const rows = prepared.all(...values) as Record<string, unknown>[];
    return { rows, count: rows.length };
  }
  return { rows: [], count: Number(prepared.run(...values).changes) };
}

/** The SQL functions, on the connection or inside one transaction. */
export interface Sql {
  /** The rows of one statement, converted. */
  rows<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** The one row of a statement. Throws unless there is exactly one. */
  row<T = Row>(text: string, params?: unknown[]): Promise<T>;
  /** The first column of the first row, converted, or null when there is no row. */
  scalar<T = unknown>(text: string, params?: unknown[]): Promise<T>;
  /** Runs one statement. Returns the number of rows it changed. */
  exec(text: string, params?: unknown[]): Promise<number>;
  /** The number of rows in `table` that match an optional WHERE clause. */
  count(table: string, where?: string, params?: unknown[]): Promise<number>;
  /**
   * Inserts rows into `table` and returns them, converted. Keys are camelCase
   * or snake_case. A timestamp that the application fills on insert is set to
   * now when it is missing.
   */
  insertRows<T = Row>(table: string, values: Row[]): Promise<T[]>;
  /** Inserts one row into `table` and returns it, converted. */
  insert<T = Row>(table: string, value: Row): Promise<T>;
}

const api: Sql = {
  async rows<T = Row>(text: string, params: unknown[] = []) {
    return run(text, params).rows.map((raw) => toRow<T>(raw));
  },
  async row<T = Row>(text: string, params: unknown[] = []) {
    const result = await api.rows<T>(text, params);
    if (result.length !== 1) throw new Error(`Expected one row, got ${result.length}: ${text}`);
    return result[0];
  },
  async scalar<T = unknown>(text: string, params: unknown[] = []) {
    const [first] = run(text, params).rows;
    if (!first) return null as T;
    const [column, value] = Object.entries(first)[0];
    return convert(column, value) as T;
  },
  async exec(text: string, params: unknown[] = []) {
    return run(text, params).count;
  },
  async count(table: string, where = "1 = 1", params: unknown[] = []) {
    return Number(await api.scalar(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
  },
  async insertRows<T = Row>(table: string, values: Row[]) {
    if (values.length === 0) return [];
    const now = new Date();
    const records = values.map((value) => {
      const record: Row = {};
      for (const column of NOW_COLUMNS[table] ?? []) record[column] = now;
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) record[snakeCase(key)] = item;
      }
      return record;
    });
    const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
    const params: unknown[] = [];
    const tuples = records.map((record) => `(${columns.map((column) => {
      params.push(column in record ? record[column] : null);
      return `$${params.length}`;
    }).join(", ")})`);
    const quoted = columns.map((column) => `"${column}"`).join(", ");
    return api.rows<T>(`INSERT INTO ${table} (${quoted}) VALUES ${tuples.join(", ")} RETURNING *`, params);
  },
  async insert<T = Row>(table: string, value: Row) {
    const [inserted] = await api.insertRows<T>(table, [value]);
    return inserted;
  },
};

export const { rows, row, scalar, exec, count, insertRows, insert } = api;

/**
 * Runs `work` in one write transaction (`BEGIN IMMEDIATE`): it commits when
 * `work` resolves, and rolls back when it throws. The server waits for it.
 */
export async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
  const db = connection();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await work(api);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Runs statements separated by semicolons, with no parameters. */
export async function script(text: string): Promise<void> {
  connection().exec(text);
}

/** The columns of every application table, in table and column order. */
export async function tableColumns(): Promise<Array<{ table: string; column: string; timestamp: boolean }>> {
  const result = run(
    `SELECT m.name AS table_name, p.name AS column_name
     FROM sqlite_master m JOIN pragma_table_info(m.name) p
     WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> '_sqlx_migrations'
     ORDER BY m.name, p.cid`,
    [],
  ).rows;
  return result.map((raw) => ({
    table: String(raw.table_name),
    column: String(raw.column_name),
    timestamp: String(raw.column_name).endsWith("_at"),
  }));
}
