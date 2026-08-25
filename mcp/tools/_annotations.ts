import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Named annotation presets. Every registerTool call passes one of these as its
 * `annotations` key, so a client can tell a query from a delete without
 * reading the description.
 *
 * The hints are advisory. A client is not obliged to honour them, so they are
 * a presentation aid, never an authorization check. Book ownership is enforced
 * by requireBookAuth in mcp/auth.ts.
 *
 * **Every hint is set explicitly. None is left to its default.** The MCP
 * defaults are not the safe-looking ones: `destructiveHint` defaults to
 * `true` and `openWorldHint` defaults to `true`, so an omitted hint claims
 * MORE about a tool than saying nothing would. Omitting `openWorldHint` on
 * these presets made every database-only tool advertise itself as reaching an
 * open world of external entities, which erased the whole distinction from
 * READ_NETWORK. `annotations.test.ts` asserts the explicitness so it cannot
 * regress.
 *
 * `idempotentHint` is the exception the spec itself carves out: it is
 * "meaningful only when readOnlyHint == false", so the read presets leave it
 * unset rather than assert something the spec ignores.
 */

/** A query against this book's database. Changes nothing, reaches nothing. */
export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** A query that leaves this process to answer — PostHog, Tiingo, Plaid. */
export const READ_NETWORK: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Adds a row via a write that is not safe to retry blindly. Running it twice
 * does not always land in the same state: for most CREATE tools it adds a
 * second row (create_transaction), but some refuse the retry outright instead
 * — create_payee on an exact-name repeat, create_security on a duplicate
 * symbol. idempotentHint is false either way, since neither outcome is "no
 * change".
 */
export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Changes a row in place. Running it twice lands in the same state. */
export const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Removes data. Also correct for an update that discards data it was not
 * given — update_transaction replaces every split when it receives any.
 */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Removes data AND lands in a different state when repeated — unlike
 * DESTRUCTIVE, whose idempotentHint promises a retry is safe.
 * reconcile_plaid_transaction's 'create' action is the case that motivated
 * this preset: loadReconciliationRow() in lib/plaid-reconcile.ts matches on
 * id, link and book, but not on resolutionStatus, so a second 'create' call
 * on the same reconciliationId does not detect that the row was already
 * resolved. It runs the whole branch again — inserts a second transaction
 * and overwrites matchedTransactionId to point at the new one. The first
 * transaction stays in the ledger, marked reconciled, linked to nothing, and
 * invisible to getStaleUnmatched() (which only flags isReconciled = false).
 * A client that trusts idempotentHint and retries a timed-out call would
 * create exactly that duplicate-plus-orphan pair in someone's real financial
 * records. Use this preset for any tool with the same shape: destructive,
 * and not safe to retry blindly.
 */
export const DESTRUCTIVE_NONIDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Changes data AND leaves this process to do it — the Plaid sync. Distinct
 * from READ_NETWORK, which is for a query that reaches out (Tiingo, PostHog)
 * and changes nothing: a client that trusts READ_NETWORK's readOnlyHint
 * could auto-approve this tool, which stages rows, mutates reconciliation
 * state and commits a sync cursor.
 *
 * idempotentHint is false: a second sync is not a no-op. It fetches whatever
 * Plaid has produced since the cursor this one committed, so running it twice
 * can land in a different state than running it once.
 */
export const WRITE_NETWORK: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
