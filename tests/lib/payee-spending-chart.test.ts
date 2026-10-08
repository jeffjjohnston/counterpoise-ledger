import { describe, expect, it } from "vitest";
import { toPayeeSpendingChart } from "@/lib/payee-spending-chart";
import type { ReportSplit } from "@/lib/reports";

function split(id: number, date: string, accountType: string, amount: number): ReportSplit {
  return {
    splitId: id, transactionId: id, date, amount, accountId: id, accountName: `Account ${id}`,
    accountType, accountParentId: null, payeeId: 7, payeeName: "Cafe",
  };
}

describe("toPayeeSpendingChart", () => {
  it("gives no chart without income or expense", () => {
    expect(toPayeeSpendingChart([], "2025-11", "2026-10")).toBeNull();
  });

  it("gives a group for each of the 12 months, with zeros for the empty ones, oldest first", () => {
    const data = toPayeeSpendingChart([
      split(1, "2026-01-05", "expense", 3_000),
      split(2, "2026-07-20", "expense", 2_000),
    ], "2025-11", "2026-10")!;
    expect(data.groups.map((group) => group.key)).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
      "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(data.groups[0].label).toBe("November 2025");
    expect(data.groups[0].bars).toEqual([
      { key: "expense", label: "Expense", segments: [{ seriesKey: "expense", value: 0 }] },
    ]);
    expect(data.groups[2].bars[0].segments).toEqual([{ seriesKey: "expense", value: 3_000 }]);
    expect(data.groups[8].bars[0].segments).toEqual([{ seriesKey: "expense", value: 2_000 }]);
    expect(data.ariaLabel).toBe("Totals by month, November 2025 to October 2026: Expense $50.00");
  });
});
