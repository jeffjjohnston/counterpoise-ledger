/**
 * The contract number a client compares against. Increase it when a field is
 * removed or renamed, when a type changes, or when a route the contract
 * covers goes away. Adding an optional field does not change it.
 *
 * Keep the history here so a bump is a deliberate edit:
 *   1 — 2026-09-21: first contract (auth, books, accounts, transactions,
 *       payees, search, account values, version).
 */
export const API_CONTRACT = 1;

/** Injected from package.json by vite.config.ts at build time. */
export function getAppVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev";
}
