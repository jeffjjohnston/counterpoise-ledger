import { describe, it, expect } from "vitest";
import { buildAccountTree } from "@/lib/accounting";
import type { AccountWithBalance } from "@/types";

describe("buildAccountTree - alphabetical sorting", () => {
  it("should sort root accounts alphabetically", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Zebra",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 2,
        bookId: 1,
        name: "Apple",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 3,
        bookId: 1,
        name: "Mango",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
    ];

    const tree = buildAccountTree(accounts);

    expect(tree).toHaveLength(3);
    expect(tree[0].name).toBe("Apple");
    expect(tree[1].name).toBe("Mango");
    expect(tree[2].name).toBe("Zebra");
  });

  it("should sort child accounts alphabetically", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Parent",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 2,
        bookId: 1,
        name: "Child Z",
        type: "income",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 3,
        bookId: 1,
        name: "Child A",
        type: "income",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 4,
        bookId: 1,
        name: "Child M",
        type: "income",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
    ];

    const tree = buildAccountTree(accounts);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Parent");
    expect(tree[0].children).toHaveLength(3);
    expect(tree[0].children![0].name).toBe("Child A");
    expect(tree[0].children![1].name).toBe("Child M");
    expect(tree[0].children![2].name).toBe("Child Z");
  });

  it("should sort nested children recursively", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Grandparent",
        type: "expense",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 2,
        bookId: 1,
        name: "Parent B",
        type: "expense",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 3,
        bookId: 1,
        name: "Parent A",
        type: "expense",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 4,
        bookId: 1,
        name: "Grandchild 2",
        type: "expense",
        subtype: null,
        parentId: 3,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 5,
        bookId: 1,
        name: "Grandchild 1",
        type: "expense",
        subtype: null,
        parentId: 3,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
    ];

    const tree = buildAccountTree(accounts);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Grandparent");
    expect(tree[0].children).toHaveLength(2);

    // Parents should be sorted
    expect(tree[0].children![0].name).toBe("Parent A");
    expect(tree[0].children![1].name).toBe("Parent B");

    // Grandchildren under Parent A should be sorted
    expect(tree[0].children![0].children).toHaveLength(2);
    expect(tree[0].children![0].children![0].name).toBe("Grandchild 1");
    expect(tree[0].children![0].children![1].name).toBe("Grandchild 2");
  });

  it("should handle mixed income and expense accounts with sorting", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Salary",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 2,
        bookId: 1,
        name: "Bonus",
        type: "income",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
      {
        id: 3,
        bookId: 1,
        name: "Base Pay",
        type: "income",
        subtype: null,
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
    isFavorite: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
    hasTransactions: true,
        children: [],
      },
    ];

    const tree = buildAccountTree(accounts);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Salary");
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children![0].name).toBe("Base Pay");
    expect(tree[0].children![1].name).toBe("Bonus");
  });
});
