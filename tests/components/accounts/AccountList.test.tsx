import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AccountList } from "@/components/accounts/AccountList";
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

describe("AccountList", () => {
  it("hides investment cash accounts and rolls cash into investment totals", () => {
    const investmentCashAccount: AccountWithBalance = {
      id: 2,
      bookId: 1,
      name: "Investment Cash",
      type: "asset",
      subtype: "cash",
      parentId: 1,
      isActive: true,
      isFavorite: false,
      isInvestmentCash: true,
      icon: null,
      balance: 2500,
      hasTransactions: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Investment",
        type: "asset",
        subtype: "investment",
        parentId: null,
        isActive: true,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        balance: 10000,
      hasTransactions: true,
        children: [investmentCashAccount],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      investmentCashAccount,
      {
        id: 3,
        bookId: 1,
        name: "Checking",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        balance: 3000,
      hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <AccountList
        accounts={accounts}
        selectedAccountId={null}
        showInactive
      />
    );

    expect(screen.queryByText("Investment Cash")).not.toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument();
    expect(screen.getByText("Cash $25.00")).toBeInTheDocument();
  });

  it("indents child accounts beneath their parents", () => {
    const parentAccount: AccountWithBalance = {
      id: 10,
      bookId: 1,
      name: "Main Account",
      type: "asset",
      subtype: "bank",
      parentId: null,
      isActive: true,
      isFavorite: false,
      isInvestmentCash: false,
      icon: null,
      balance: 5000,
      hasTransactions: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const childAccount: AccountWithBalance = {
      id: 11,
      bookId: 1,
      name: "Sub Account",
      type: "asset",
      subtype: "bank",
      parentId: 10,
      isActive: true,
      isFavorite: false,
      isInvestmentCash: false,
      icon: null,
      balance: 2000,
      hasTransactions: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    render(
      <AccountList
        accounts={[parentAccount, childAccount]}
        selectedAccountId={null}
        showInactive
      />
    );

    const parentLink = screen.getByText("Main Account").closest("a");
    const childLink = screen.getByText("Sub Account").closest("a");

    expect(parentLink).toBeInTheDocument();
    expect(childLink).toBeInTheDocument();

    const parentPadding = Number.parseFloat(
      parentLink?.style.paddingLeft || "0"
    );
    const childPadding = Number.parseFloat(
      childLink?.style.paddingLeft || "0"
    );

    expect(childPadding).toBeGreaterThan(parentPadding);
  });

  it("shows favorites above the All Accounts link", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 1,
        bookId: 1,
        name: "Favorite Checking",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isFavorite: true,
        isInvestmentCash: false,
        icon: null,
        balance: 5000,
      hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 2,
        bookId: 1,
        name: "Regular Savings",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        balance: 3000,
      hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<AccountList accounts={accounts} selectedAccountId={null} showInactive />);

    const favoritesSection = screen.getByText("Favorites").closest("div");
    const favoriteLink = within(favoritesSection as HTMLElement)
      .getByText("Favorite Checking")
      .closest("a");
    const allAccountsLink = screen.getByText("All Accounts").closest("a");

    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(favoriteLink).toBeInTheDocument();
    expect(allAccountsLink).toBeInTheDocument();
    expect(
      favoriteLink?.compareDocumentPosition(allAccountsLink as Node)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("uses the provided basePath for account and all-accounts links", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 7,
        bookId: 1,
        name: "Checking",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: true,
        isFavorite: true,
        isInvestmentCash: false,
        icon: null,
        balance: 1000,
      hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <AccountList
        accounts={accounts}
        selectedAccountId={null}
        showInactive
        basePath="/b/42/transactions"
      />
    );

    const accountLinks = screen.getAllByRole("link", { name: /Checking/ });
    const allAccountsLink = screen.getByText("All Accounts").closest("a");

    expect(accountLinks).toHaveLength(2);
    accountLinks.forEach((link) => {
      expect(link).toHaveAttribute("href", "/b/42/transactions?accountId=7");
    });
    expect(allAccountsLink).toHaveAttribute("href", "/b/42/transactions");
  });

  it("renders income accounts without an Other subtype bucket", () => {
    const accounts: AccountWithBalance[] = [
      {
        id: 9,
        bookId: 1,
        name: "Salary",
        type: "income",
        subtype: null,
        parentId: null,
        isActive: true,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        balance: -500000,
      hasTransactions: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(<AccountList accounts={accounts} selectedAccountId={null} showInactive />);

    const incomeButton = screen.getByText("Income").closest("button");
    expect(incomeButton).toBeInTheDocument();
    fireEvent.click(incomeButton as HTMLButtonElement);

    expect(screen.getByRole("link", { name: /Salary/ })).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });
});
