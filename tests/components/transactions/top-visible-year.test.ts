import { describe, it, expect } from "vitest";
import { topVisibleYear } from "@/components/transactions/top-visible-year";

// Each row is 40px high. The first row starts at `firstTop`.
const layout = (years: (string | null)[], firstTop: number) => ({
  count: years.length,
  bottom: (index: number) => firstTop + (index + 1) * 40,
  year: (index: number) => years[index],
});

describe("topVisibleYear", () => {
  const years = ["2026", "2026", "2025", "2025", "2024"];

  it("gives the year of the first row when the list is not scrolled", () => {
    const rows = layout(years, 50);
    expect(topVisibleYear(rows.count, rows.bottom, rows.year, 50)).toBe("2026");
  });

  it("changes year when the last row of a year goes fully below the header", () => {
    // The header bottom is at 50. Row 1 (2026) has its bottom at 51: one pixel shows.
    let rows = layout(years, 50 - 79);
    expect(topVisibleYear(rows.count, rows.bottom, rows.year, 50)).toBe("2026");
    // One more pixel of scroll: the bottom of row 1 is at 50, thus row 2 (2025) is the top row.
    rows = layout(years, 50 - 80);
    expect(topVisibleYear(rows.count, rows.bottom, rows.year, 50)).toBe("2025");
  });

  it("skips a row that has no year", () => {
    const rows = layout([null, "2025"], 50);
    expect(topVisibleYear(rows.count, rows.bottom, rows.year, 50)).toBe("2025");
  });

  it("gives null when all rows are above the header", () => {
    const rows = layout(years, -1000);
    expect(topVisibleYear(rows.count, rows.bottom, rows.year, 50)).toBeNull();
  });

  it("gives null when the rows have no layout", () => {
    expect(topVisibleYear(3, () => 0, () => "2026", 0)).toBeNull();
  });
});
