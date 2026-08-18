import { sql } from "drizzle-orm";
import { getDb, type AppDb } from "@/db";
import { users } from "@/db/schema";

type TransactionDb = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type RegistrationDb = AppDb | TransactionDb;

/**
 * Serialises the bootstrap check against concurrent registrations. Held for the
 * life of the transaction, so the zero-user count and the insert cannot
 * interleave with another request doing the same. Registration is rare enough
 * that a global lock costs nothing.
 */
export const REGISTRATION_LOCK_ID = 4_242_424_242;

/**
 * Three states, one place:
 *
 *   "true"  — always open
 *   "false" — always closed
 *   unset   — open only while the users table is empty
 *
 * The unset default lets a fresh install bootstrap its first account and then
 * close by itself, so there is no configuration step and no window in which a
 * forgotten default leaves registration open.
 */
export async function isRegistrationOpen(
  client: RegistrationDb = getDb()
): Promise<boolean> {
  const flag = process.env.REGISTRATION_ENABLED;
  if (flag === "true") return true;
  if (flag === "false") return false;

  const [row] = await client
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(users);

  return (row?.count ?? 0) === 0;
}
