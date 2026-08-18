import { describe, expect, it } from "vitest";
import {
  buildTopParentMap,
  computeGrandTotal,
  groupSplits,
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

  it("groups by month and collapses child accounts to their top parent", () => {
    const groups = groupSplits(splits, ["month", "account"], accountMap, true);

    expect(groups.map((group) => group.label)).toEqual([
      "January 2025",
      "February 2025",
    ]);

    expect(groups[0].children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Expenses", total: 12_500 }),
        expect.objectContaining({ label: "Income", total: 50_000 }),
      ])
    );
  });

  it("uses a fallback label for missing payees", () => {
    const groups = groupSplits(splits, ["payee"], accountMap, false);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "(No payee)", total: 12_500 }),
        expect.objectContaining({ label: "Acme Corp", total: 50_000 }),
      ])
    );
  });
});

describe("computeGrandTotal", () => {
  it("sums display balances across account types", () => {
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

    expect(computeGrandTotal(splits)).toBe(95_000);
  });
});
