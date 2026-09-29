/**
 * How well a payee name matches a typed search term. This module has no
 * imports, so the autocomplete component and the server query can both use
 * it. The SQL in `listPayees()` applies the same three tiers before its
 * LIMIT, so the eight rows a form receives are the eight best, not the
 * eight that sort first by name.
 *
 * Tiers, best first:
 *   0 - the name starts with the term ("United" for "uni")
 *   1 - a word in the name starts with the term ("Credit Union" for "uni")
 *   2 - the term occurs somewhere else ("Reunion Hall" for "uni")
 *
 * A word starts after a space. Stored names have their whitespace collapsed
 * to single spaces by `normalizePayeeName()`, so this agrees with the SQL
 * pattern `'% term%'`.
 */
export type PayeeMatchRank = 0 | 1 | 2;

export function rankPayeeMatch(name: string, term: string): PayeeMatchRank {
  const lowerName = name.toLowerCase();
  const lowerTerm = term.toLowerCase();
  if (lowerName.startsWith(lowerTerm)) return 0;
  if (lowerName.includes(` ${lowerTerm}`)) return 1;
  return 2;
}

/** Sort comparator: better rank first, then name order. */
export function comparePayeeMatches(a: string, b: string, term: string): number {
  const rankDelta = rankPayeeMatch(a, term) - rankPayeeMatch(b, term);
  if (rankDelta !== 0) return rankDelta;
  return a.localeCompare(b);
}
