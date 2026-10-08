import { describe, expect, it } from "vitest";
import { groupSplits, type GroupDimension, type ReportAccount, type ReportSplit } from "@/lib/reports";
import { OTHER_KEY, toChartData } from "@/lib/report-chart";

let nextId = 1;
const accounts = new Map<number, ReportAccount>();

/** One split. The account is added to the account map the first time. */
function split(date: string, accountId: number, type: string, amount: number, payee?: [number, string]): ReportSplit {
  if (!accounts.has(accountId)) {
    accounts.set(accountId, { id: accountId, name: `Account ${accountId}`, type, parentId: null });
  }
  const id = nextId++;
  return {
    splitId: id, transactionId: id, date, amount, accountId,
    accountName: `Account ${accountId}`, accountType: type, accountParentId: null,
    payeeId: payee?.[0] ?? null, payeeName: payee?.[1] ?? null,
  };
}

function chart(splits: ReportSplit[], dimensions: GroupDimension[]) {
  return toChartData(groupSplits(splits, dimensions, accounts, false), dimensions);
}

describe("toChartData", () => {
  it("gives no chart without a grouping or without rows", () => {
    expect(chart([split("2026-01-05", 10, "income", -500)], [])).toBeNull();
    expect(chart([], ["month"])).toBeNull();
  });

  it("gives one group for each month with one bar for each account type", () => {
    const data = chart([
      split("2026-01-05", 10, "income", -500_000),
      split("2026-01-09", 20, "expense", 20_000),
      split("2026-02-03", 20, "expense", 30_000),
    ], ["month"])!;
    expect(data.orientation).toBe("vertical");
    expect(data.series).toEqual([
      { key: "income", label: "Income", color: "var(--chart-1)" },
      { key: "expense", label: "Expense", color: "var(--chart-2)" },
    ]);
    expect(data.groups.map((group) => group.key)).toEqual(["2026-01", "2026-02"]);
    expect(data.groups[0].bars).toEqual([
      { key: "income", label: "Income", segments: [{ seriesKey: "income", value: 500_000 }] },
      { key: "expense", label: "Expense", segments: [{ seriesKey: "expense", value: 20_000 }] },
    ]);
    expect(data.groups[1].bars[0].segments).toEqual([{ seriesKey: "income", value: 0 }]);
    expect(data.ariaLabel).toBe("Totals by month, January 2026 to February 2026: Income $5,000.00, Expense $500.00");
  });

  it("stacks the 7 largest accounts and puts the rest in Other", () => {
    const splits = [21, 22, 23, 24, 25, 26, 27, 28, 29].map((accountId, index) =>
      split("2026-01-10", accountId, "expense", (9 - index) * 1000));
    const data = chart(splits, ["month", "account"])!;
    expect(data.series).toHaveLength(8);
    expect(data.series[7]).toEqual({ key: OTHER_KEY, label: "Other", color: "var(--chart-8)" });
    const segments = data.groups[0].bars[0].segments;
    expect(segments).toHaveLength(8);
    expect(segments.find((segment) => segment.seriesKey === OTHER_KEY)).toEqual({ seriesKey: OTHER_KEY, value: 3000 });
  });

  it("ranks payees, keeps the 10 largest and adds the rest as Other", () => {
    const splits = Array.from({ length: 12 }, (_, index) =>
      split("2026-01-10", 20, "expense", (index + 1) * 100, [100 + index, `Payee ${index + 1}`]));
    const data = chart(splits, ["payee"])!;
    expect(data.orientation).toBe("horizontal");
    expect(data.groups).toHaveLength(11);
    expect(data.groups[0].label).toBe("Payee 12");
    expect(data.groups[10]).toEqual({
      key: OTHER_KEY, label: "Other",
      bars: [{ key: "total", label: "Other", segments: [{ seriesKey: OTHER_KEY, value: 300 }] }],
    });
    expect(data.ariaLabel).toBe("Totals by payee, largest Payee 12 at $12.00, all $78.00");
  });

  it("charts one period with one account type", () => {
    const data = chart([split("2026-03-02", 20, "expense", 4200)], ["month"])!;
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].bars).toHaveLength(1);
    expect(data.ariaLabel).toBe("Totals by month, March 2026 to March 2026: Expense $42.00");
  });

  it("gives a payee with income and expense one bar for each type, both positive", () => {
    const data = chart([
      split("2026-01-15", 10, "income", -300_000, [1, "Employer"]),
      split("2026-01-15", 20, "expense", 80_000, [1, "Employer"]),
      split("2026-01-16", 20, "expense", 5_000, [2, "Grocer"]),
    ], ["payee"])!;
    expect(data.series).toEqual([
      { key: "income", label: "Income", color: "var(--chart-1)" },
      { key: "expense", label: "Expense", color: "var(--chart-2)" },
    ]);
    expect(data.groups[0].label).toBe("Employer");
    expect(data.groups[0].bars).toEqual([
      { key: "income", label: "Income", segments: [{ seriesKey: "income", value: 300_000 }] },
      { key: "expense", label: "Expense", segments: [{ seriesKey: "expense", value: 80_000 }] },
    ]);
    expect(data.groups[1].bars[0].segments[0].value).toBe(0);
    expect(data.ariaLabel).toBe("Totals by payee, largest Employer at $3,800.00, all $3,850.00");
  });

  it("puts the rest of the payees into Other with one bar for each type", () => {
    const splits = Array.from({ length: 12 }, (_, index) => [
      split("2026-01-10", 10, "income", -(index + 1) * 1000, [100 + index, `Payee ${index + 1}`]),
      split("2026-01-10", 20, "expense", (index + 1) * 100, [100 + index, `Payee ${index + 1}`]),
    ]).flat();
    const data = chart(splits, ["payee"])!;
    const other = data.groups[10];
    expect(other.key).toBe(OTHER_KEY);
    expect(other.bars.map((bar) => bar.segments[0].value)).toEqual([3000, 300]);
    expect(data.series.map((item) => item.key)).toEqual(["income", "expense"]);
  });

  it("gives each account one bar, positive, under one Total series, when no account mixes types", () => {
    const data = chart([
      split("2026-01-15", 30, "income", -500_000),
      split("2026-01-16", 31, "expense", 20_000),
      split("2026-01-17", 32, "expense", 80_000),
    ], ["account"])!;
    expect(data.orientation).toBe("horizontal");
    expect(data.series).toEqual([{ key: "total", label: "Total", color: "var(--chart-1)" }]);
    expect(data.groups.map((group) => group.label)).toEqual(["Account 30", "Account 32", "Account 31"]);
    for (const group of data.groups) expect(group.bars).toHaveLength(1);
    expect(data.groups.map((group) => group.bars[0].segments)).toEqual([
      [{ seriesKey: "total", value: 500_000 }],
      [{ seriesKey: "total", value: 80_000 }],
      [{ seriesKey: "total", value: 20_000 }],
    ]);
  });

  it("adds income and expense accounts as absolute amounts in the label", () => {
    // Account 33 holds only a refund, so its display total is negative. The absolute sum is $6,300.00
    // and the signed sum is $5,700.00.
    const data = chart([
      split("2026-01-15", 30, "income", -500_000),
      split("2026-01-16", 31, "expense", 20_000),
      split("2026-01-17", 32, "expense", 80_000),
      split("2026-01-18", 33, "expense", -30_000),
    ], ["account"])!;
    expect(data.ariaLabel).toBe("Totals by account, largest Account 30 at $5,000.00, all $6,300.00");
  });

  it("puts the rest of more than 10 accounts of mixed types into one Other bar", () => {
    const splits = Array.from({ length: 12 }, (_, index) => index % 2 === 0
      ? split("2026-01-10", 40 + index, "income", -(index + 1) * 1000)
      : split("2026-01-10", 40 + index, "expense", (index + 1) * 1000));
    const data = chart(splits, ["account"])!;
    expect(data.groups).toHaveLength(11);
    expect(data.groups[10]).toEqual({
      key: OTHER_KEY, label: "Other",
      bars: [{ key: "total", label: "Other", segments: [{ seriesKey: OTHER_KEY, value: 3000 }] }],
    });
    expect(data.series).toEqual([
      { key: "total", label: "Total", color: "var(--chart-1)" },
      { key: OTHER_KEY, label: "Other", color: "var(--chart-8)" },
    ]);
  });
});

describe("toChartData with child accounts collapsed to the parent", () => {
  // Parent 60 holds an income child 61 and an expense child 62. Parents 80 to 86 have no children.
  const others = [80, 81, 82, 83, 84, 85, 86];
  const tree = new Map<number, ReportAccount>([
    [60, { id: 60, name: "Side business", type: "income", parentId: null }],
    [61, { id: 61, name: "Sales", type: "income", parentId: 60 }],
    [62, { id: 62, name: "Supplies", type: "expense", parentId: 60 }],
    ...others.map((id): [number, ReportAccount] => [id, { id, name: `Parent ${id}`, type: "expense", parentId: null }]),
  ]);

  function treeSplit(date: string, accountId: number, amount: number): ReportSplit {
    const account = tree.get(accountId)!;
    const id = nextId++;
    return {
      splitId: id, transactionId: id, date, amount, accountId,
      accountName: account.name, accountType: account.type, accountParentId: account.parentId,
      payeeId: null, payeeName: null,
    };
  }

  function collapsedChart(splits: ReportSplit[]) {
    const dimensions: GroupDimension[] = ["month", "account"];
    return toChartData(groupSplits(splits, dimensions, tree, true), dimensions)!;
  }

  it("puts the income of a mixed parent in the income bar and its expense in the expense bar, both positive", () => {
    const data = collapsedChart([
      treeSplit("2026-01-10", 61, -100_000),
      treeSplit("2026-01-12", 62, 20_000),
    ]);
    const [income, expense] = data.groups[0].bars;
    expect(income.key).toBe("income");
    expect(income.segments).toEqual([{ seriesKey: "account:60", value: 100_000 }]);
    expect(expense.key).toBe("expense");
    expect(expense.segments).toEqual([{ seriesKey: "account:60", value: 20_000 }]);
  });

  it("ranks a mixed parent by the sum of its absolute type totals, not by its total", () => {
    // Parent 60: income $1,000 and an expense refund of $900. Its total is $100, its weight is $1,900.
    // Seven other expense parents of $500 each fill the other named series.
    const data = collapsedChart([
      treeSplit("2026-01-10", 61, -100_000),
      treeSplit("2026-01-12", 62, -90_000),
      ...others.map((id) => treeSplit("2026-01-15", id, 50_000)),
    ]);
    expect(data.series[0]).toEqual({ key: "account:60", label: "Side business", color: "var(--chart-1)" });
  });
});
