import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { AccountCard } from "@/components/accounts/AccountCard";
import type { AccountWithBalance } from "@/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("AccountCard", () => {
  it("indents child accounts beneath their parents", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Primary Account",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
      isFavorite: false,
        balance: 10000,
    hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 2,
        bookId: 1,
        name: "Secondary Account",
        type: "asset",
        subtype: "bank",
        parentId: 1,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
      isFavorite: false,
        balance: 2500,
    hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<AccountCard type="asset" accounts={accounts} total={12500} />);

    const parentLink = screen.getByText("Primary Account").closest("div");
    const childLink = screen.getByText("Secondary Account").closest("div");

    expect(parentLink).toBeInTheDocument();
    expect(childLink).toBeInTheDocument();

    const parentPadding = Number.parseFloat(
      parentLink?.style.paddingLeft || "0"
    );
    const childPadding = Number.parseFloat(childLink?.style.paddingLeft || "0");

    expect(childPadding).toBeGreaterThan(parentPadding);
  });

  it("uses the provided basePath for account links", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 7,
        bookId: 1,
        name: "Checking",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
      isFavorite: false,
        balance: 10000,
    hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <AccountCard
        type="asset"
        accounts={accounts}
        total={10000}
        basePath="/b/42/transactions"
      />
    );

    expect(screen.getByRole("link", { name: "Checking" })).toHaveAttribute(
      "href",
      "/b/42/transactions?accountId=7"
    );
  });

  it("merges linkParams (e.g. a date range) into account links", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 9,
        bookId: 1,
        name: "Groceries",
        type: "expense",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
        isFavorite: false,
        balance: 32000,
        hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <AccountCard
        type="expense"
        accounts={accounts}
        total={32000}
        basePath="/b/42/transactions"
        linkParams={{
          startDate: "2026-01-01",
          endDate: "2026-06-18",
        }}
      />
    );

    expect(screen.getByRole("link", { name: "Groceries" })).toHaveAttribute(
      "href",
      "/b/42/transactions?accountId=9&startDate=2026-01-01&endDate=2026-06-18"
    );
  });

  it("omits empty linkParams values from account links", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 10,
        bookId: 1,
        name: "Utilities",
        type: "expense",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
        isFavorite: false,
        balance: 12000,
        hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <AccountCard
        type="expense"
        accounts={accounts}
        total={12000}
        basePath="/b/42/transactions"
        linkParams={{ startDate: undefined, endDate: undefined }}
      />
    );

    expect(screen.getByRole("link", { name: "Utilities" })).toHaveAttribute(
      "href",
      "/b/42/transactions?accountId=10"
    );
  });

  it("renders income accounts without an Other subtype bucket", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 8,
        bookId: 1,
        name: "Salary",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isInvestmentCash: false,
        icon: null,
      isFavorite: false,
        balance: -450000,
    hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<AccountCard type="income" accounts={accounts} total={-450000} />);

    expect(screen.getByRole("link", { name: "Salary" })).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });
});
