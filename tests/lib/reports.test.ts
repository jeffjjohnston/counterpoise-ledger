import { describe, expect, it } from "vitest";
import {
  buildTopParentMap,
  computeGrandTotal,
  groupSplits,
  isMixedReport,
  reportAmount,
  type ReportAccount,
  type ReportSplit,
} from "@/lib/reports";

function buildAccountMap(accounts: ReportAccount[]) {
  return new Map(accounts.map((account) => [account.id, account]));
}

describe("buildTopParentMap", () => {
  it("resolves nested accounts to their top-level parent", () => {
    const accountMap = buildAccountMap([
      { id: 1, name: "Expenses", type: "expense", parentId: null },
      { id: 2, name: "Food", type: "expense", parentId: 1 },
      { id: 3, name: "Dining", type: "expense", parentId: 2 },
    ]);

    const topParentMap = buildTopParentMap(accountMap);

    expect(topParentMap.get(1)).toBe(1);
    expect(topParentMap.get(2)).toBe(1);
    expect(topParentMap.get(3)).toBe(1);
  });
});

describe("groupSplits", () => {
  const accountMap = buildAccountMap([
    { id: 1, name: "Income", type: "income", parentId: null },
    { id: 2, name: "Salary", type: "income", parentId: 1 },
    { id: 3, name: "Expenses", type: "expense", parentId: null },
    { id: 4, name: "Groceries", type: "expense", parentId: 3 },
  ]);

  const splits: ReportSplit[] = [
    {
      splitId: 1,
      transactionId: 10,
      date: "2025-01-15",
      amount: -50_000,
      accountId: 2,
      accountName: "Salary",
      accountType: "income",
      accountParentId: 1,
      payeeId: 1,
      payeeName: "Acme Corp",
    },
    {
      splitId: 2,
      transactionId: 11,
      date: "2025-01-20",
      amount: 12_500,
      accountId: 4,
      accountName: "Groceries",
      accountType: "expense",
      accountParentId: 3,
      payeeId: null,
      payeeName: null,
    },
    {
      splitId: 3,
      transactionId: 12,
      date: "2025-02-01",
      amount: 9_999,
      accountId: 4,
      accountName: "Groceries",
      accountType: "expense",
      accountParentId: 3,
      payeeId: 2,
      payeeName: "Corner Store",
    },
  ];

  it("groups by month and collapses child accounts to their top parent, with a signed net in a mixed report", () => {
    const groups = groupSplits(splits, ["month", "account"], accountMap, true);

    expect(groups.map((group) => group.label)).toEqual([
      "January 2025",
      "February 2025",
    ]);

    expect(groups[0].children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Expenses", total: -12_500 }),
        expect.objectContaining({ label: "Income", total: 50_000 }),
      ])
    );
  });

  it("uses a fallback label for missing payees", () => {
    const groups = groupSplits(splits, ["payee"], accountMap, false);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "(No payee)", total: -12_500 }),
        expect.objectContaining({ label: "Acme Corp", total: 50_000 }),
      ])
    );
  });
});

describe("computeGrandTotal", () => {
  it("gives income less expense for a report with income and expense", () => {
    const splits: ReportSplit[] = [
      {
        splitId: 1,
        transactionId: 1,
        date: "2025-01-01",
        amount: -75_000,
        accountId: 1,
        accountName: "Salary",
        accountType: "income",
        accountParentId: null,
        payeeId: 1,
        payeeName: "Employer",
      },
      {
        splitId: 2,
        transactionId: 2,
        date: "2025-01-02",
        amount: 20_000,
        accountId: 2,
        accountName: "Groceries",
        accountType: "expense",
        accountParentId: null,
        payeeId: 2,
        payeeName: "Market",
      },
    ];

    expect(computeGrandTotal(splits)).toBe(55_000);
  });
});

describe("signed net in a mixed report", () => {
  let nextId = 1;
  function split(date: string, accountId: number, accountType: string, amount: number): ReportSplit {
    const id = nextId++;
    return {
      splitId: id, transactionId: id, date, amount, accountId,
      accountName: `Account ${accountId}`, accountType, accountParentId: null,
      payeeId: null, payeeName: null,
    };
  }
  const accountMap = buildAccountMap([
    { id: 1, name: "Salary", type: "income", parentId: null },
    { id: 2, name: "Rent", type: "expense", parentId: null },
    { id: 3, name: "Checking", type: "asset", parentId: null },
    { id: 4, name: "Card", type: "liability", parentId: null },
  ]);

  it("gives each month the income less the expense, and the grand total the sum of the months", () => {
    const splits = [
      split("2026-01-05", 1, "income", -500_000),
      split("2026-01-10", 2, "expense", 300_000),
      split("2026-02-10", 2, "expense", 300_000),
    ];
    const groups = groupSplits(splits, ["month"], accountMap, false);

    expect(groups.map((group) => group.total)).toEqual([200_000, -300_000]);
    expect(computeGrandTotal(splits)).toBe(-100_000);
  });

  it("gives each split the sign of the net, so that the splits of a group add to its total", () => {
    const splits = [
      split("2026-01-05", 1, "income", -500_000),
      split("2026-01-10", 2, "expense", 300_000),
      split("2026-01-12", 2, "expense", -20_000),
    ];
    const [group] = groupSplits(splits, ["month"], accountMap, false);
    const mixed = isMixedReport(splits);

    expect(mixed).toBe(true);
    expect(group.splits.map((s) => reportAmount(s, mixed))).toEqual([500_000, -300_000, 20_000]);
    expect(group.splits.reduce((sum, s) => sum + reportAmount(s, mixed), 0)).toBe(group.total);
  });

  it("gives assets less liabilities for a report with assets and liabilities", () => {
    const splits = [
      split("2026-01-05", 3, "asset", 900_000),
      split("2026-01-06", 4, "liability", -150_000),
    ];

    expect(computeGrandTotal(splits)).toBe(750_000);
  });

  it("keeps the display balance, positive, in a report with one account type", () => {
    const splits = [
      split("2026-01-10", 2, "expense", 300_000),
      split("2026-02-10", 2, "expense", 100_000),
      split("2026-02-12", 2, "expense", -25_000),
    ];
    const groups = groupSplits(splits, ["month"], accountMap, false);

    expect(isMixedReport(splits)).toBe(false);
    expect(groups.map((group) => group.total)).toEqual([300_000, 75_000]);
    expect(computeGrandTotal(splits)).toBe(375_000);
    expect(reportAmount(splits[2], false)).toBe(-25_000);
  });
});
