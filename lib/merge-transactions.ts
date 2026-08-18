import type { DisplayTransaction } from "@/types";

/**
 * Merge projected (upcoming) and actual transactions into a single
 * date-descending array suitable for display. Interleaves by date
 * so that manually-entered future transactions appear in proper
 * chronological position among projected ones.
 *
 * Sort order: date DESC, then actual before projected for same date,
 * then id DESC as final tiebreaker.
 */
export function mergeTransactionsForDisplay(
  projected: DisplayTransaction[],
  actual: DisplayTransaction[]
): DisplayTransaction[] {
  if (projected.length === 0 && actual.length === 0) return [];

  const merged = [...projected, ...actual];
  merged.sort((a, b) => {
    // Primary: date descending
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    // Secondary: actual before projected (actual = not projected)
    const aProj = a.isProjected ? 1 : 0;
    const bProj = b.isProjected ? 1 : 0;
    if (aProj !== bProj) return aProj - bProj;
    // Tertiary: id descending
    return b.id - a.id;
  });
  return merged;
}
