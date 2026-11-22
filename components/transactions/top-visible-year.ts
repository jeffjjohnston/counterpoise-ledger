import { useEffect, useRef, useState } from "react";

/** The attribute that a register row uses to give the year of its effective date. */
export const ROW_YEAR_ATTRIBUTE = "data-effective-year";

/**
 * The year of the first row that shows below the sticky header.
 *
 * `rowBottoms` must be in document order, thus the values do not decrease. A
 * row is "below the header" when its bottom edge is lower than the bottom edge
 * of the header. The function returns `null` when no row is below the header,
 * or when the rows have no layout (jsdom gives 0 for each edge).
 */
export function topVisibleYear(
  rowCount: number,
  rowBottom: (index: number) => number,
  rowYear: (index: number) => string | null,
  headerBottom: number
): string | null {
  // Binary search: the first index with a bottom edge below the header.
  let low = 0;
  let high = rowCount;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rowBottom(middle) > headerBottom) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  // A row without a year (a row that is not a transaction) gives its turn to
  // the next row.
  for (let index = low; index < rowCount; index++) {
    const year = rowYear(index);
    if (year) return year;
  }
  return null;
}

/**
 * Follows the year of the top visible register row while the page scrolls.
 *
 * Attach `headerRef` to a sticky header cell and `bodyRef` to the `tbody`.
 * The result is `null` until the first measurement, and when no row is below
 * the header. The caller then shows the year of the first row.
 *
 * The scroll listener is on `document` in the capture phase, because the
 * register does not own its scroll container and a scroll event does not
 * bubble. `remeasureKey` starts a new measurement when the rows change.
 */
export function useTopVisibleYear(remeasureKey: unknown) {
  const headerRef = useRef<HTMLTableCellElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [year, setYear] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const header = headerRef.current;
      const body = bodyRef.current;
      if (!header || !body) {
        setYear(null);
        return;
      }
      const rows = body.rows;
      setYear(
        topVisibleYear(
          rows.length,
          (index) => rows[index].getBoundingClientRect().bottom,
          (index) => rows[index].getAttribute(ROW_YEAR_ATTRIBUTE),
          header.getBoundingClientRect().bottom
        )
      );
    };
    // One measurement for each frame is sufficient: a scroll can send many
    // events between two paints.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    schedule();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [remeasureKey]);

  return { headerRef, bodyRef, year };
}
