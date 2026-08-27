import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TransactionList, computeRowMenuPosition } from "@/components/transactions/TransactionList";
import type { TransactionWithSplits, AccountWithBalance, DisplayTransaction } from "@/types";

// Controllable mobile flag so we can exercise both the desktop table and the mobile
// card layouts. Defaults to desktop (matches jsdom, which lacks matchMedia).
const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileRef.value,
}));

afterEach(() => {
  isMobileRef.value = false;
});

const baseTransaction = {
  date: "2024-02-01",
  description: "Test",
  checkNumber: null,
  notes: null,
  payeeId: null,
  isReconciled: false,
  isFloating: false,
  recurringRuleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  payee: null,
  investmentSplits: [],
};

// Mock accounts for hierarchy testing
const mockAccounts: AccountWithBalance[] = [
  {
    id: 1,
    bookId: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 2,
    bookId: 1,
    name: "Groceries",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 3,
    bookId: 1,
    name: "Utilities",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 10,
    bookId: 1,
    name: "Brokerage",
    type: "asset",
    subtype: "investment",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 11,
    bookId: 1,
    name: "Brokerage Cash",
    type: "asset",
    subtype: "cash",
    parentId: 10,
    isActive: true,
    isInvestmentCash: true,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 20,
    bookId: 1,
    name: "Shopping",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 21,
    bookId: 1,
    name: "Clothing",
    type: "expense",
    subtype: null,
    parentId: 20,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
      isFavorite: false,
    balance: 0,
    hasTransactions: true,
    children: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe("TransactionList", () => {
  it("uses the balance account to calculate running balance", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 1,
        bookId: 1,
        splits: [
          {
            id: 11,
            bookId: 1,
            transactionId: 1,
            accountId: 1,
            amount: 5000,
            account: {
              id: 1,
              bookId: 1,
              name: "Investment",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 12,
            bookId: 1,
            transactionId: 1,
            accountId: 2,
            amount: 2500,
            account: {
              id: 2,
              bookId: 1,
              name: "Investment Cash",
              type: "asset",
              subtype: "cash",
              parentId: 1,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
      {
        ...baseTransaction,
        id: 2,
        bookId: 1,
        date: "2024-02-02",
        splits: [
          {
            id: 21,
            bookId: 1,
            transactionId: 2,
            accountId: 1,
            amount: -3000,
            account: {
              id: 1,
              bookId: 1,
              name: "Investment",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 22,
            bookId: 1,
            transactionId: 2,
            accountId: 2,
            amount: -500,
            account: {
              id: 2,
              bookId: 1,
              name: "Investment Cash",
              type: "asset",
              subtype: "cash",
              parentId: 1,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        balanceAccountId={2}
        startingBalance={10000}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("+$25.00")).toBeInTheDocument();
    expect(screen.getByText("−$5.00")).toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument();
    expect(screen.getByText("$120.00")).toBeInTheDocument();
  });

  it("shows note tooltip content without truncating the payee cell", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 101,
        bookId: 1,
        notes: "Bring receipt",
        payeeId: 42,
        payee: {
          id: 42,
          bookId: 1,
          name: "Corner Store",
          createdAt: new Date(),
        },
        splits: [
          {
            id: 1011,
            bookId: 1,
            transactionId: 101,
            accountId: 1,
            amount: -1200,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 1012,
            bookId: 1,
            transactionId: 101,
            accountId: 2,
            amount: 1200,
            account: {
              id: 2,
              bookId: 1,
              name: "Groceries",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    const payeeCell = screen.getByText("Corner Store").closest("td");
    expect(payeeCell).toBeInTheDocument();
    expect(payeeCell).not.toHaveClass("truncate");

    fireEvent.mouseEnter(screen.getByLabelText("Has notes"));
    expect(screen.getByText("Bring receipt")).toBeInTheDocument();
  });

  it("shows plus icons when the selected account balance increases", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 3,
        bookId: 1,
        splits: [
          {
            id: 31,
            bookId: 1,
            transactionId: 3,
            accountId: 1,
            amount: 1000,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 32,
            bookId: 1,
            transactionId: 3,
            accountId: 2,
            amount: -600,
            account: {
              id: 2,
              bookId: 1,
              name: "Groceries",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 33,
            bookId: 1,
            transactionId: 3,
            accountId: 3,
            amount: -400,
            account: {
              id: 3,
              bookId: 1,
              name: "Utilities",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    // Direction is carried by the amount, not by a glyph repeated once per
    // related account (both of these splits oppose the selected account).
    expect(screen.getByTestId("transaction-amount-3"))
      .toHaveTextContent("+$10.00");
    expect(screen.queryByText("+")).not.toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Utilities")).toBeInTheDocument();
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
  });

  it("shows minus icons when the selected account balance decreases", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 4,
        bookId: 1,
        splits: [
          {
            id: 41,
            bookId: 1,
            transactionId: 4,
            accountId: 1,
            amount: 1500,
            account: {
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
            },
          },
          {
            id: 42,
            bookId: 1,
            transactionId: 4,
            accountId: 2,
            amount: -1500,
            account: {
              id: 2,
              bookId: 1,
              name: "Savings",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={2}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-amount-4"))
      .toHaveTextContent("−$15.00");
    expect(screen.queryByText("−")).not.toBeInTheDocument();
    expect(screen.queryByText("Savings")).not.toBeInTheDocument();
  });

  it("shows minus for credit card charges and plus for payments", () => {
    // Credit card charge: credit card split is negative (charge increases balance owed)
    const chargeTransactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 5,
        bookId: 1,
        splits: [
          {
            id: 51,
            bookId: 1,
            transactionId: 5,
            accountId: 1,
            amount: 4500,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 52,
            bookId: 1,
            transactionId: 5,
            accountId: 2,
            amount: -4500,
            account: {
              id: 2,
              bookId: 1,
              name: "Credit Card",
              type: "liability",
              subtype: "credit_card",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    const { unmount } = render(
      <TransactionList
        transactions={chargeTransactions}
        accounts={mockAccounts}
        selectedAccountId={2}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Checking")).toBeInTheDocument();
    // Negative amount on liability = charge, shown as a minus on the amount
    expect(screen.getByTestId("transaction-amount-5"))
      .toHaveTextContent("−$45.00");
    expect(screen.queryByText("−")).not.toBeInTheDocument();
    expect(screen.queryByText("Credit Card")).not.toBeInTheDocument();

    unmount();

    // Credit card payment: credit card split is positive (payment reduces balance owed)
    const paymentTransactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 6,
        bookId: 1,
        splits: [
          {
            id: 61,
            bookId: 1,
            transactionId: 6,
            accountId: 1,
            amount: -4500,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 62,
            bookId: 1,
            transactionId: 6,
            accountId: 2,
            amount: 4500,
            account: {
              id: 2,
              bookId: 1,
              name: "Credit Card",
              type: "liability",
              subtype: "credit_card",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={paymentTransactions}
        accounts={mockAccounts}
        selectedAccountId={2}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Checking")).toBeInTheDocument();
    // Positive amount on liability = payment, shown as a plus on the amount
    expect(screen.getByTestId("transaction-amount-6"))
      .toHaveTextContent("+$45.00");
    expect(screen.queryByText("+")).not.toBeInTheDocument();
  });

  describe("floating transactions", () => {
    const floating: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 70,
        bookId: 1,
        isFloating: true,
        date: "2024-02-01",
        payee: { id: 7, bookId: 1, name: "Landlord", createdAt: new Date() },
        payeeId: 7,
        splits: [
          {
            id: 701,
            bookId: 1,
            transactionId: 70,
            accountId: 1,
            amount: -2000,
            account: mockAccounts[0],
          },
          {
            id: 702,
            bookId: 1,
            transactionId: 70,
            accountId: 2,
            amount: 2000,
            account: mockAccounts[1],
          },
        ],
      },
    ];

    it("labels a floating transaction with a Float pill in the register", () => {
      render(
        <TransactionList
          transactions={floating}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
        />
      );

      expect(screen.getByText("Float")).toBeInTheDocument();
      // The bare "~" it used to prefix the date with is gone.
      expect(screen.queryByText(/^~/)).not.toBeInTheDocument();
    });

    it("labels a floating transaction with a Float pill on the mobile card", () => {
      isMobileRef.value = true;
      render(
        <TransactionList
          transactions={floating}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
        />
      );

      expect(screen.getByText("Float")).toBeInTheDocument();
      expect(screen.queryByText(/^~/)).not.toBeInTheDocument();
    });

    it("does not show a Float pill on a settled transaction", () => {
      render(
        <TransactionList
          transactions={[{ ...floating[0], isFloating: false }]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
        />
      );

      expect(screen.queryByText("Float")).not.toBeInTheDocument();
    });
  });

  it("shows investment action details when viewing an investment account", () => {
    const security = {
      id: 99,
      bookId: 1,
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock" as const,
      fetchPrices: true,
      fixedPriceMicros: null,
      createdAt: new Date(),
    };

    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 6,
        bookId: 1,
        description: "Buy shares",
        splits: [
          {
            id: 61,
            bookId: 1,
            transactionId: 6,
            accountId: 10,
            amount: 15000,
            account: {
              id: 10,
              bookId: 1,
              name: "Brokerage",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 62,
            bookId: 1,
            transactionId: 6,
            accountId: 11,
            amount: -15000,
            account: {
              id: 11,
              bookId: 1,
              name: "Brokerage Cash",
              type: "asset",
              subtype: "cash",
              parentId: 10,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
        investmentSplits: [
          {
            id: 601,
            bookId: 1,
            transactionId: 6,
            securityId: security.id,
            lotId: null,
            action: "buy",
            sharesMicros: 2_000_000,
            priceMicros: 7_500_000,
            feesCents: 0,
            accountId: null,
            splitNumerator: null,
            splitDenominator: null,
            security,
          },
        ],
      },
      {
        ...baseTransaction,
        id: 7,
        bookId: 1,
        date: "2024-02-03",
        description: "Dividend",
        splits: [
          {
            id: 71,
            bookId: 1,
            transactionId: 7,
            accountId: 10,
            amount: 0,
            account: {
              id: 10,
              bookId: 1,
              name: "Brokerage",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 72,
            bookId: 1,
            transactionId: 7,
            accountId: 11,
            amount: 500,
            account: {
              id: 11,
              bookId: 1,
              name: "Brokerage Cash",
              type: "asset",
              subtype: "cash",
              parentId: 10,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 73,
            bookId: 1,
            transactionId: 7,
            accountId: 12,
            amount: -500,
            account: {
              id: 12,
              bookId: 1,
              name: "Dividend Income",
              type: "income",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
        investmentSplits: [
          {
            id: 701,
            bookId: 1,
            transactionId: 7,
            securityId: security.id,
            lotId: null,
            action: "dividend",
            sharesMicros: 0,
            priceMicros: 0,
            feesCents: 0,
            accountId: null,
            splitNumerator: null,
            splitDenominator: null,
            security,
          },
        ],
      },
      {
        ...baseTransaction,
        id: 8,
        bookId: 1,
        date: "2024-02-04",
        description: "Sell shares",
        splits: [
          {
            id: 81,
            bookId: 1,
            transactionId: 8,
            accountId: 10,
            amount: -12000,
            account: {
              id: 10,
              bookId: 1,
              name: "Brokerage",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 82,
            bookId: 1,
            transactionId: 8,
            accountId: 11,
            amount: 12000,
            account: {
              id: 11,
              bookId: 1,
              name: "Brokerage Cash",
              type: "asset",
              subtype: "cash",
              parentId: 10,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
        investmentSplits: [
          {
            id: 801,
            bookId: 1,
            transactionId: 8,
            securityId: security.id,
            lotId: null,
            action: "sell",
            sharesMicros: 1_500_000,
            priceMicros: 8_000_000,
            feesCents: 0,
            accountId: null,
            splitNumerator: null,
            splitDenominator: null,
            security,
          },
        ],
      },
      {
        ...baseTransaction,
        id: 9,
        bookId: 1,
        date: "2024-02-05",
        description: "Capital gain",
        splits: [
          {
            id: 91,
            bookId: 1,
            transactionId: 9,
            accountId: 10,
            amount: 0,
            account: {
              id: 10,
              bookId: 1,
              name: "Brokerage",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 92,
            bookId: 1,
            transactionId: 9,
            accountId: 11,
            amount: 700,
            account: {
              id: 11,
              bookId: 1,
              name: "Brokerage Cash",
              type: "asset",
              subtype: "cash",
              parentId: 10,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 93,
            bookId: 1,
            transactionId: 9,
            accountId: 13,
            amount: -700,
            account: {
              id: 13,
              bookId: 1,
              name: "Capital Gain Income",
              type: "income",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
        investmentSplits: [
          {
            id: 901,
            bookId: 1,
            transactionId: 9,
            securityId: security.id,
            lotId: null,
            action: "capGain",
            sharesMicros: 0,
            priceMicros: 0,
            feesCents: 0,
            accountId: null,
            splitNumerator: null,
            splitDenominator: null,
            security,
          },
        ],
      },
      {
        ...baseTransaction,
        id: 10,
        bookId: 1,
        date: "2024-02-06",
        description: "Stock split",
        splits: [
          {
            id: 101,
            bookId: 1,
            transactionId: 10,
            accountId: 10,
            amount: 0,
            account: {
              id: 10,
              bookId: 1,
              name: "Brokerage",
              type: "asset",
              subtype: "investment",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 102,
            bookId: 1,
            transactionId: 10,
            accountId: 11,
            amount: 0,
            account: {
              id: 11,
              bookId: 1,
              name: "Brokerage Cash",
              type: "asset",
              subtype: "cash",
              parentId: 10,
              isActive: true,
              isInvestmentCash: true,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
        investmentSplits: [
          {
            id: 1001,
            bookId: 1,
            transactionId: 10,
            securityId: security.id,
            lotId: null,
            action: "split",
            sharesMicros: 0,
            priceMicros: 0,
            feesCents: 0,
            accountId: null,
            splitNumerator: 2,
            splitDenominator: 1,
            security,
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={10}
        balanceAccountId={11}
        onEdit={vi.fn()}
      />
    );

    // Every action reaches the register with its own tag, and the two that carry
    // a quantity expose it as separate Shares / Price cells.
    expect(screen.getByText("BUY")).toBeInTheDocument();
    expect(screen.getByText("SELL")).toBeInTheDocument();
    expect(screen.getByText("DIV")).toBeInTheDocument();
    expect(screen.getByText("CAPGAIN")).toBeInTheDocument();
    expect(screen.getByText("SPLIT")).toBeInTheDocument();
    expect(screen.getByText("ACME 2-for-1")).toBeInTheDocument();
    expect(screen.getByText("$7.50")).toBeInTheDocument();
    expect(screen.getByText("$8.00")).toBeInTheDocument();
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.queryByText("Brokerage Cash")).not.toBeInTheDocument();
  });

  it("renders payee names when provided", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 11,
        bookId: 1,
        description: "Coffee",
        payeeId: 55,
        payee: {
          id: 55,
          bookId: 1,
          name: "Blue Bottle",
          createdAt: new Date(),
        },
        splits: [
          {
            id: 111,
            bookId: 1,
            transactionId: 11,
            accountId: 1,
            amount: 500,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 112,
            bookId: 1,
            transactionId: 11,
            accountId: 2,
            amount: -500,
            account: {
              id: 2,
              bookId: 1,
              name: "Coffee",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Blue Bottle")).toBeInTheDocument();
  });

  it("renders Recurring before payee for projected transactions", () => {
    const transactions: DisplayTransaction[] = [
      {
        ...baseTransaction,
        id: 12,
        bookId: 1,
        description: "Scheduled rent",
        payeeId: 77,
        payee: {
          id: 77,
          bookId: 1,
          name: "Landlord",
          createdAt: new Date(),
        },
        isProjected: true,
        splits: [
          {
            id: 121,
            bookId: 1,
            transactionId: 12,
            accountId: 1,
            amount: -120000,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 122,
            bookId: 1,
            transactionId: 12,
            accountId: 2,
            amount: 120000,
            account: {
              id: 2,
              bookId: 1,
              name: "Rent",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
      />
    );

    const payeeCell = screen.getByText("Recurring").closest("td");
    expect(payeeCell).toHaveTextContent(/^Recurring\s*Landlord$/);
  });

  it("reserves the amount indicator slot for projected transactions", () => {
    const transactions: DisplayTransaction[] = [
      {
        ...baseTransaction,
        id: 20,
        bookId: 1,
        date: "2026-03-11",
        payeeId: 201,
        payee: { id: 201, bookId: 1, name: "Cleared payment", createdAt: new Date() },
        isReconciled: true,
        splits: [
          {
            id: 201,
            bookId: 1,
            transactionId: 20,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 202,
            bookId: 1,
            transactionId: 20,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: -20,
        bookId: 1,
        date: "2026-03-12",
        payeeId: 202,
        payee: { id: 202, bookId: 1, name: "Projected payment", createdAt: new Date() },
        isProjected: true,
        splits: [
          {
            id: 203,
            bookId: 1,
            transactionId: -20,
            accountId: 1,
            amount: -1200,
            account: mockAccounts[0],
          },
          {
            id: 204,
            bookId: 1,
            transactionId: -20,
            accountId: 2,
            amount: 1200,
            account: mockAccounts[1],
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    const actualIndicator = screen.getByTestId("transaction-reconciled-indicator-20");
    const projectedIndicator = screen.getByTestId("transaction-reconciled-indicator--20");

    expect(actualIndicator).not.toHaveClass("invisible");
    expect(projectedIndicator).toHaveClass("invisible");
  });

  it("renders projected and actual transactions interleaved by date", () => {
    const transactions: DisplayTransaction[] = [
      {
        ...baseTransaction,
        id: -1,
        bookId: 1,
        date: "2026-04-01",
        payeeId: 101,
        payee: { id: 101, bookId: 1, name: "Projected Apr", createdAt: new Date() },
        isProjected: true,
        splits: [
          {
            id: 1,
            bookId: 1,
            transactionId: -1,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 2,
            bookId: 1,
            transactionId: -1,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: -2,
        bookId: 1,
        date: "2026-03-27",
        payeeId: 102,
        payee: { id: 102, bookId: 1, name: "Projected Mar 27", createdAt: new Date() },
        isProjected: true,
        splits: [
          {
            id: 3,
            bookId: 1,
            transactionId: -2,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 4,
            bookId: 1,
            transactionId: -2,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: -3,
        bookId: 1,
        date: "2026-03-19",
        payeeId: 103,
        payee: { id: 103, bookId: 1, name: "Projected Mar 19", createdAt: new Date() },
        isProjected: true,
        splits: [
          {
            id: 5,
            bookId: 1,
            transactionId: -3,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 6,
            bookId: 1,
            transactionId: -3,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: 100,
        bookId: 1,
        date: "2026-03-23",
        payeeId: 201,
        payee: { id: 201, bookId: 1, name: "Actual Mar 23", createdAt: new Date() },
        splits: [
          {
            id: 7,
            bookId: 1,
            transactionId: 100,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 8,
            bookId: 1,
            transactionId: 100,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: 99,
        bookId: 1,
        date: "2026-03-16",
        payeeId: 202,
        payee: { id: 202, bookId: 1, name: "Actual Mar 16", createdAt: new Date() },
        splits: [
          {
            id: 9,
            bookId: 1,
            transactionId: 99,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 10,
            bookId: 1,
            transactionId: 99,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
      {
        ...baseTransaction,
        id: -4,
        bookId: 1,
        date: "2026-03-16",
        payeeId: 104,
        payee: { id: 104, bookId: 1, name: "Projected Mar 16", createdAt: new Date() },
        isProjected: true,
        splits: [
          {
            id: 11,
            bookId: 1,
            transactionId: -4,
            accountId: 1,
            amount: -1000,
            account: mockAccounts[0],
          },
          {
            id: 12,
            bookId: 1,
            transactionId: -4,
            accountId: 2,
            amount: 1000,
            account: mockAccounts[1],
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    const rows = screen.getAllByRole("row").slice(1, 7);
    const rowDates = rows.map(
      (row) => row.querySelectorAll("td")[0]?.textContent?.trim() || ""
    );

    // The register prints the year on its first row and the day alone after
    // that, and blanks a date that repeats the row above -- the last row here
    // reads as empty to the eye and carries an sr-only date for a reader.
    expect(rowDates).toEqual([
      "Apr 1, 2026",
      "Mar 27",
      "Mar 23",
      "Mar 19",
      "Mar 16",
      "Mar 16, 2026",
    ]);

    const mar16Rows = rows.filter((row) =>
      row.querySelectorAll("td")[0]?.textContent?.includes("Mar 16")
    );
    expect(mar16Rows).toHaveLength(2);
    expect(mar16Rows[0].textContent).not.toContain("Recurring");
    expect(mar16Rows[1].textContent).toContain("Recurring");
  });

  it("shows a check-number pill in the payee column", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 12,
        bookId: 1,
        description: "Rent check",
        checkNumber: "1234",
        splits: [
          {
            id: 121,
            bookId: 1,
            transactionId: 12,
            accountId: 2,
            amount: 150000,
            account: {
              id: 2,
              bookId: 1,
              name: "Rent",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 122,
            bookId: 1,
            transactionId: 12,
            accountId: 1,
            amount: -150000,
            account: {
              id: 1,
              bookId: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
      isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
      />
    );

    const checkPill = screen.getByText("CHK #1234");
    expect(checkPill).toBeInTheDocument();

    const row = checkPill.closest("tr");
    if (!row) {
      throw new Error("Expected check-number pill to be within a table row");
    }

    const cells = row.querySelectorAll("td");
    expect(cells[1]).toContainElement(checkPill);
    expect(cells[2]).not.toContainElement(checkPill);
  });

  it("shows a go-to account action in the context menu and calls navigation callback", () => {
    const onNavigateToAccount = vi.fn();
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 13,
        bookId: 1,
        description: "Clothes purchase",
        splits: [
          {
            id: 131,
            bookId: 1,
            transactionId: 13,
            accountId: 1,
            amount: -5000,
            account: {
              id: 1,
              bookId: 1,
              name: "Credit Card",
              type: "liability",
              subtype: "credit_card",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 132,
            bookId: 1,
            transactionId: 13,
            accountId: 21,
            amount: 5000,
            account: {
              id: 21,
              bookId: 1,
              name: "Clothing",
              type: "expense",
              subtype: null,
              parentId: 20,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onNavigateToAccount={onNavigateToAccount}
      />
    );

    fireEvent.contextMenu(screen.getByText(/Shopping\s*:\s*Clothing/));

    const goToButton = screen.getByRole("menuitem", {
      name: /Go to Shopping\s*:\s*Clothing/,
    });
    expect(goToButton).toBeInTheDocument();

    fireEvent.click(goToButton);

    expect(onNavigateToAccount).toHaveBeenCalledWith(21, 13);
  });

  it("shows go-to actions for each counterpart account in split transactions", () => {
    const transactions: TransactionWithSplits[] = [
      {
        ...baseTransaction,
        id: 14,
        bookId: 1,
        description: "Split purchase",
        splits: [
          {
            id: 141,
            bookId: 1,
            transactionId: 14,
            accountId: 1,
            amount: -10000,
            account: {
              id: 1,
              bookId: 1,
              name: "Credit Card",
              type: "liability",
              subtype: "credit_card",
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 142,
            bookId: 1,
            transactionId: 14,
            accountId: 21,
            amount: 6000,
            account: {
              id: 21,
              bookId: 1,
              name: "Clothing",
              type: "expense",
              subtype: null,
              parentId: 20,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            id: 143,
            bookId: 1,
            transactionId: 14,
            accountId: 2,
            amount: 4000,
            account: {
              id: 2,
              bookId: 1,
              name: "Groceries",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isInvestmentCash: false,
              icon: null,
              isFavorite: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
    ];

    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onNavigateToAccount={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText(/Shopping\s*:\s*Clothing/));

    expect(
      screen.getByRole("menuitem", {
        name: /Go to Shopping\s*:\s*Clothing/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Go to Groceries" })
    ).toBeInTheDocument();
  });

  it("renders skeleton rows when isLoading is true", () => {
    render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
        isLoading
      />
    );
    expect(screen.getAllByTestId("transaction-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.queryByText("No transactions found")).not.toBeInTheDocument();
  });

  it("keeps the row-actions trigger out of the row height calculation", () => {
    const { container } = render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onToggleReconciled={vi.fn()}
      />
    );

    // The trigger is h-7 (28px) and every text cell is a 20px line box, so the
    // actions cell has to carry less vertical padding or the button, not the
    // type, decides how tall a row is.
    const textCell = container.querySelector("tbody td");
    const actionsCell = container.querySelector("tbody tr td:last-child");
    expect(textCell).toHaveClass("py-3");
    expect(actionsCell).toHaveClass("py-2");
  });

  it("reveals the row-actions trigger on hover and on focus, not always", () => {
    const { container } = render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onToggleReconciled={vi.fn()}
      />
    );

    const trigger = screen.getByLabelText("Transaction actions");
    expect(trigger).toHaveClass("opacity-0", "pointer-events-none");
    expect(trigger).toHaveClass("group-hover/row:opacity-100", "focus-visible:opacity-100");
    // The row owns the named group the trigger keys off.
    expect(container.querySelector("tbody tr")).toHaveClass("group/row");
  });

  describe("date column", () => {
    const onDate = (id: number, date: string): TransactionWithSplits => ({
      ...baseTransaction,
      id,
      bookId: 1,
      date,
      splits: [
        { id: id * 10, bookId: 1, transactionId: id, accountId: 1, amount: -100, account: mockAccounts[0] },
        { id: id * 10 + 1, bookId: 1, transactionId: id, accountId: 2, amount: 100, account: mockAccounts[1] },
      ],
    });

    const dateCells = (container: HTMLElement) =>
      [...container.querySelectorAll("tbody tr")].map(
        (row) => row.querySelectorAll("td")[0]?.textContent ?? ""
      );

    it("prints the date once per day and drops the year", () => {
      const { container } = render(
        <TransactionList
          transactions={[onDate(1, "2024-02-02"), onDate(2, "2024-02-01"), onDate(3, "2024-02-01")]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
        />
      );

      const [first, second, third] = dateCells(container);
      // First row of the register carries the year; the next day does not.
      expect(first).toBe("Feb 2, 2024");
      expect(second).toBe("Feb 1");
      // Same day as the row above: blank to the eye, still dated for a reader.
      expect(third).toBe("Feb 1, 2024");
      expect(
        container.querySelectorAll("tbody tr")[2].querySelector(".sr-only")
      ).toHaveTextContent("Feb 1, 2024");
    });

    it("brings the year back on the row where it changes", () => {
      const { container } = render(
        <TransactionList
          transactions={[onDate(1, "2024-01-02"), onDate(2, "2023-12-31")]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
        />
      );

      expect(dateCells(container)).toEqual(["Jan 2, 2024", "Dec 31, 2023"]);
    });
  });

  // An empty register renders the empty state, not the table, so these need a row.
  const oneRow: TransactionWithSplits[] = [
    {
      ...baseTransaction,
      id: 80,
      bookId: 1,
      splits: [
        { id: 801, bookId: 1, transactionId: 80, accountId: 1, amount: -500, account: mockAccounts[0] },
        { id: 802, bookId: 1, transactionId: 80, accountId: 2, amount: 500, account: mockAccounts[1] },
      ],
    },
  ];

  it("trails cleared status behind the money, and money alone in Amount", () => {
    const { container } = render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onToggleReconciled={vi.fn()}
      />
    );

    const indicator = screen.getByTestId("transaction-reconciled-indicator-80");
    const amount = screen.getByTestId("transaction-amount-80");
    const cells = [...container.querySelectorAll("tbody tr td")];

    // Cleared status sits with the numbers it qualifies -- Amount, Balance,
    // status -- rather than across the row from them.
    expect(cells[cells.length - 4]).toBe(amount);
    expect(cells[cells.length - 2]).toContainElement(indicator);

    // ...but the actions trigger keeps the last column. Reaching for the row
    // menu must never land on the reconcile toggle, which writes on one click.
    expect(cells[cells.length - 1]).toContainElement(
      screen.getByRole("button", { name: "Transaction actions" })
    );

    // Amount carries the amount and nothing else.
    expect(amount).not.toContainElement(indicator);
    expect(amount.textContent).toBe("−$5.00");
  });

  it("gives the reconcile control a hit target larger than the dot it shows", () => {
    render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onToggleReconciled={vi.fn()}
      />
    );

    const control = screen.getByTestId("transaction-reconciled-indicator-80");
    // 20px box around a 14px dot: the box is what you have to hit.
    expect(control).toHaveClass("h-5", "w-5");
    // Block-level, so the gutter cell has no line strut to grow past 20px and
    // become what sets the row height.
    expect(control).toHaveClass("flex");
    expect(control.className).not.toContain("inline-flex");
    expect(control.firstElementChild).toHaveClass("h-3.5", "w-3.5");
  });

  it("pins the register header and gives it a rule beneath it", () => {
    const { container } = render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        isLoading={false}
      />
    );

    const headers = [...container.querySelectorAll("thead th")];
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) {
      // Opaque background matters as much as the sticky: a transparent sticky
      // cell lets the rows scrolling underneath show through it.
      expect(th).toHaveClass("sticky", "top-0", "bg-surface", "border-b");
    }
  });

  it("does not wrap the register in a scroll container", () => {
    // Any overflow value other than `visible` makes the wrapper a scroll
    // container, and the sticky header would pin to it rather than to the
    // page -- scrolling away with the register.
    const { container } = render(
      <TransactionList
        transactions={oneRow}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        isLoading={false}
      />
    );

    expect(container.querySelector('[class*="overflow-x"]')).toBeNull();
  });

  // The register is `table-fixed`: the browser satisfies every fixed-width column
  // first and gives only what is left to the percentage columns. When the fixed
  // columns alone exceed the container, the percentage column collapses to 0px and
  // its text paints on top of the next column. The narrowest desktop container is
  // ~736px (the 1024px lg breakpoint, less the 256px sidebar and padding), so the
  // fixed columns must leave at least ~160px for the flexible column.
  const MAX_FIXED_COLUMN_REM = 36;

  const sumFixedColumnRem = (container: HTMLElement): number =>
    [...container.querySelectorAll("colgroup col")].reduce((total, col) => {
      const match = /w-\[([\d.]+)rem\]/.exec(col.className);
      return total + (match ? parseFloat(match[1]) : 0);
    }, 0);

  it("leaves room for the flexible column in the standard register", () => {
    const { container } = render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        isLoading
      />
    );

    expect(sumFixedColumnRem(container)).toBeLessThanOrEqual(MAX_FIXED_COLUMN_REM);
  });

  it("leaves room for the activity column in the investment register", () => {
    const { container } = render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={2}
        balanceAccountId={2}
        onEdit={vi.fn()}
        isLoading
      />
    );

    expect(sumFixedColumnRem(container)).toBeLessThanOrEqual(MAX_FIXED_COLUMN_REM);
  });

  it("reserves more width for payee names than accounts in the table layout", () => {
    const { container } = render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
        isLoading
      />
    );

    // The status gutter trails the numeric columns now, so the leading columns
    // are indexed straight from the front.
    const columns = container.querySelectorAll("colgroup col");
    expect(columns[1]).toHaveClass("w-[32%]");
    expect(columns[2]).toHaveClass("w-[24%]");
  });

  it("does not render skeleton rows when isLoading is false with empty transactions", () => {
    render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
        isLoading={false}
      />
    );
    expect(screen.queryByTestId("transaction-skeleton-row")).not.toBeInTheDocument();
  });

  it("shows filter hint empty state when account is selected and no transactions", () => {
    render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        isLoading={false}
      />
    );
    expect(screen.getByText("No transactions found")).toBeInTheDocument();
    expect(screen.getByText("Try adjusting your filters or date range.")).toBeInTheDocument();
  });

  it("shows 'no transactions yet' when no account selected and no transactions", () => {
    render(
      <TransactionList
        transactions={[]}
        accounts={mockAccounts}
        selectedAccountId={null}
        onEdit={vi.fn()}
        isLoading={false}
      />
    );
    expect(screen.getByText("No transactions yet")).toBeInTheDocument();
    expect(screen.getByText("Your transactions will appear here once you add them.")).toBeInTheDocument();
  });

  describe("row actions (overflow menu + reconcile toggle)", () => {
    const simpleExpense = (overrides: Partial<TransactionWithSplits> = {}): TransactionWithSplits => ({
      ...baseTransaction,
      id: 500,
      bookId: 1,
      description: "Lunch",
      splits: [
        {
          id: 5001,
          bookId: 1,
          transactionId: 500,
          accountId: 1,
          amount: -1200,
          account: {
            id: 1,
            bookId: 1,
            name: "Checking",
            type: "asset",
            subtype: "bank",
            parentId: null,
            isActive: true,
            isInvestmentCash: false,
            icon: null,
            isFavorite: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        {
          id: 5002,
          bookId: 1,
          transactionId: 500,
          accountId: 2,
          amount: 1200,
          account: {
            id: 2,
            bookId: 1,
            name: "Groceries",
            type: "expense",
            subtype: null,
            parentId: null,
            isActive: true,
            isInvestmentCash: false,
            icon: null,
            isFavorite: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ],
      ...overrides,
    });

    it("exposes a visible overflow menu carrying the reconcile action", () => {
      const onToggleReconciled = vi.fn();
      render(
        <TransactionList
          transactions={[simpleExpense()]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={onToggleReconciled}
          onNavigateToAccount={vi.fn()}
        />
      );

      const trigger = screen.getByRole("button", { name: "Transaction actions" });
      expect(trigger).toBeInTheDocument();

      fireEvent.click(trigger);

      const reconcileItem = screen.getByRole("menuitem", { name: "Reconciled" });
      fireEvent.click(reconcileItem);
      expect(onToggleReconciled).toHaveBeenCalledWith(500, true);
    });

    it("renders the reconciled indicator as a toggle that does not trigger row edit", () => {
      const onToggleReconciled = vi.fn();
      const onEdit = vi.fn();
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: false })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={onEdit}
          onToggleReconciled={onToggleReconciled}
        />
      );

      const dot = screen.getByTestId("transaction-reconciled-indicator-500");
      expect(dot.tagName).toBe("BUTTON");

      fireEvent.click(dot);
      expect(onToggleReconciled).toHaveBeenCalledWith(500, true);
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("shows a hollow indicator when unreconciled and a filled one when reconciled", () => {
      const { rerender } = render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: false })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={vi.fn()}
        />
      );

      const hollow = screen.getByTestId("transaction-reconciled-indicator-500");
      expect(hollow.firstElementChild?.className).toContain("border");
      expect(hollow.firstElementChild?.className).not.toContain("bg-fg-success");

      rerender(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: true })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={vi.fn()}
        />
      );

      const filled = screen.getByTestId("transaction-reconciled-indicator-500");
      expect(filled.firstElementChild?.className).toContain("bg-fg-success");
    });

    it("makes the overflow menu reachable on mobile (the only reconcile path on touch)", () => {
      isMobileRef.value = true;
      const onToggleReconciled = vi.fn();
      render(
        <TransactionList
          transactions={[simpleExpense()]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={onToggleReconciled}
          onNavigateToAccount={vi.fn()}
        />
      );

      // No table on mobile — the card layout is used instead.
      expect(screen.queryByRole("table")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Reconciled" }));
      expect(onToggleReconciled).toHaveBeenCalledWith(500, true);
    });

    it("hides the reconcile action when no reconcile handler is provided", () => {
      render(
        <TransactionList
          transactions={[simpleExpense()]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onNavigateToAccount={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));

      // Go-to actions remain because navigation is wired...
      expect(screen.getByText("Go to Groceries")).toBeInTheDocument();
      // ...but the reconcile action is gone (no handler to make it functional).
      expect(screen.queryByText("Reconciled")).not.toBeInTheDocument();
      expect(screen.queryByText("Unreconciled")).not.toBeInTheDocument();
    });

    it("offers a move-to-next-business-day action for unreconciled transactions", () => {
      const onMoveToNextBusinessDay = vi.fn();
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: false })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onMoveToNextBusinessDay={onMoveToNextBusinessDay}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Move to next business day" })
      );
      expect(onMoveToNextBusinessDay).toHaveBeenCalledWith(500);
    });

    it("hides the move-to-next-business-day action for reconciled transactions", () => {
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: true })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={vi.fn()}
          onMoveToNextBusinessDay={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));

      // The menu is open (reconcile action present)...
      expect(
        screen.getByRole("menuitem", { name: "Unreconciled" })
      ).toBeInTheDocument();
      // ...but the date-nudge action is not offered for a cleared transaction.
      expect(
        screen.queryByRole("menuitem", { name: "Move to next business day" })
      ).not.toBeInTheDocument();
    });

    it("offers no menu entry point when no action applies to the row", () => {
      // Only the date-nudge handler is wired, and it doesn't apply to a
      // reconciled transaction — the ⋯ trigger is hidden (aria-haspopup on a
      // button that opens nothing would lie) and right-click opens nothing
      // (an empty menu would leave invisible open-menu state behind).
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: true })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onMoveToNextBusinessDay={vi.fn()}
        />
      );

      expect(
        screen.queryByRole("button", { name: "Transaction actions" })
      ).not.toBeInTheDocument();

      fireEvent.contextMenu(screen.getByText("Groceries"));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("hides the move-to-next-business-day action when no handler is provided", () => {
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: false })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onToggleReconciled={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));

      expect(
        screen.queryByRole("menuitem", { name: "Move to next business day" })
      ).not.toBeInTheDocument();
    });

    it("offers move-to-next-business-day via right-click on the row", () => {
      const onMoveToNextBusinessDay = vi.fn();
      render(
        <TransactionList
          transactions={[simpleExpense({ isReconciled: false })]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onMoveToNextBusinessDay={onMoveToNextBusinessDay}
        />
      );

      fireEvent.contextMenu(screen.getByText("Groceries"));

      fireEvent.click(
        screen.getByRole("menuitem", { name: "Move to next business day" })
      );
      expect(onMoveToNextBusinessDay).toHaveBeenCalledWith(500);
    });

    it("exposes menu items with the menuitem role for valid ARIA menu semantics", () => {
      render(
        <TransactionList
          transactions={[simpleExpense()]}
          accounts={mockAccounts}
          selectedAccountId={1}
          onEdit={vi.fn()}
          onNavigateToAccount={vi.fn()}
          onToggleReconciled={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Transaction actions" }));

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getAllByRole("menuitem")).toHaveLength(2);
      expect(
        screen.getByRole("menuitem", { name: "Go to Groceries" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Reconciled" })
      ).toBeInTheDocument();
    });
  });
});

describe("computeRowMenuPosition", () => {
  const viewport = { viewportWidth: 1024, viewportHeight: 768 };

  it("anchors below and right-aligned to the trigger when there is room", () => {
    const pos = computeRowMenuPosition({
      triggerRect: { right: 500, bottom: 300 },
      menuWidth: 200,
      menuHeight: 100,
      ...viewport,
    });
    expect(pos).toEqual({ x: 300, y: 304 });
  });

  it("clamps upward so the menu stays on screen near the bottom edge", () => {
    const menuHeight = 120;
    const pos = computeRowMenuPosition({
      triggerRect: { right: 500, bottom: 760 },
      menuWidth: 200,
      menuHeight,
      ...viewport,
    });
    // Moved up from the naive anchor (bottom + 4 = 764) so it doesn't run off-screen.
    expect(pos.y).toBeLessThan(764);
    expect(pos.y + menuHeight).toBeLessThanOrEqual(viewport.viewportHeight);
    expect(pos.y).toBeGreaterThanOrEqual(8);
  });

  it("clamps to the right margin when the trigger is near the right edge", () => {
    const pos = computeRowMenuPosition({
      triggerRect: { right: 1020, bottom: 100 },
      menuWidth: 200,
      menuHeight: 100,
      ...viewport,
    });
    expect(pos.x).toBe(1024 - 200 - 8);
  });

  it("clamps to the left margin when the trigger is near the left edge", () => {
    const pos = computeRowMenuPosition({
      triggerRect: { right: 50, bottom: 100 },
      menuWidth: 200,
      menuHeight: 100,
      ...viewport,
    });
    expect(pos.x).toBe(8);
  });
});

describe("TransactionList Plaid pending rows", () => {
  const checkingAccount = {
    id: 1,
    bookId: 1,
    name: "Checking",
    type: "asset" as const,
    subtype: "bank" as const,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const plaidPendingTransaction: DisplayTransaction = {
    ...baseTransaction,
    id: -1000000001,
    bookId: 1,
    date: "2024-01-30",
    description: "STARBUCKS #1234",
    payee: { id: -1000000001, bookId: 1, name: "Starbucks", createdAt: new Date() },
    splits: [
      {
        id: -1000000001,
        bookId: 1,
        transactionId: -1000000001,
        accountId: 1,
        amount: -2500,
        account: checkingAccount,
      },
    ],
    isPlaidPending: true,
    plaidCategory: "Food And Drink",
  };

  const realTransaction: TransactionWithSplits = {
    ...baseTransaction,
    id: 1,
    bookId: 1,
    date: "2024-02-01",
    splits: [
      {
        id: 11,
        bookId: 1,
        transactionId: 1,
        accountId: 1,
        amount: 5000,
        account: checkingAccount,
      },
      {
        id: 12,
        bookId: 1,
        transactionId: 1,
        accountId: 2,
        amount: -5000,
        account: mockAccounts[1],
      },
    ],
  };

  it("renders the Plaid pill, category, and a dash balance", () => {
    render(
      <TransactionList
        transactions={[plaidPendingTransaction, realTransaction]}
        accounts={mockAccounts}
        selectedAccountId={1}
        startingBalance={1000}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Plaid")).toBeInTheDocument();
    expect(screen.getByText("Starbucks")).toBeInTheDocument();
    expect(screen.getByText("Food And Drink")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("excludes pending rows from the running balance", () => {
    render(
      <TransactionList
        transactions={[plaidPendingTransaction, realTransaction]}
        accounts={mockAccounts}
        selectedAccountId={1}
        startingBalance={1000}
        onEdit={vi.fn()}
      />
    );

    // 1000 starting + 5000 real = $60.00; the pending row's -2500 (dated
    // earlier) must not shift it to $35.00
    expect(screen.getByText("$60.00")).toBeInTheDocument();
    expect(screen.queryByText("$35.00")).not.toBeInTheDocument();
  });

  it("routes clicks to onPlaidPendingClick instead of onEdit", () => {
    const onEdit = vi.fn();
    const onPlaidPendingClick = vi.fn();
    render(
      <TransactionList
        transactions={[plaidPendingTransaction]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={onEdit}
        onPlaidPendingClick={onPlaidPendingClick}
      />
    );

    fireEvent.click(screen.getByText("Starbucks"));
    expect(onPlaidPendingClick).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("renders no reconcile toggle for pending rows", () => {
    render(
      <TransactionList
        transactions={[plaidPendingTransaction]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
        onToggleReconciled={vi.fn()}
      />
    );

    const indicator = screen.getByTestId(
      "transaction-reconciled-indicator--1000000001"
    );
    expect(indicator.tagName).toBe("SPAN");
    expect(indicator).toHaveClass("invisible");
  });

  it("shows the Plaid pill in the mobile layout", () => {
    isMobileRef.value = true;
    render(
      <TransactionList
        transactions={[plaidPendingTransaction]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Plaid")).toBeInTheDocument();
    expect(screen.getByText("Starbucks")).toBeInTheDocument();
  });
});

describe("TransactionList investment register", () => {
  const security = {
    id: 99,
    bookId: 1,
    name: "Acme Corp",
    symbol: "ACME",
    securityType: "stock" as const,
    fetchPrices: true,
    fixedPriceMicros: null,
    createdAt: new Date(),
  };

  const plainAccount = (id: number) => {
    const found = mockAccounts.find((a) => a.id === id)!;
    const { balance, hasTransactions, children, ...account } = found;
    void balance;
    void hasTransactions;
    void children;
    return account;
  };

  /** A trade: cash sub-account (11) moves by `cashAmount`, brokerage (10) offsets it. */
  const investmentTransaction = (
    id: number,
    cashAmount: number,
    investmentSplit: Partial<TransactionWithSplits["investmentSplits"][number]>
  ): TransactionWithSplits => ({
    ...baseTransaction,
    id,
    bookId: 1,
    description: "Trade",
    splits: [
      {
        id: id * 10 + 1,
        bookId: 1,
        transactionId: id,
        accountId: 10,
        amount: -cashAmount,
        account: plainAccount(10),
      },
      {
        id: id * 10 + 2,
        bookId: 1,
        transactionId: id,
        accountId: 11,
        amount: cashAmount,
        account: plainAccount(11),
      },
    ],
    investmentSplits: [
      {
        id: id * 100,
        bookId: 1,
        transactionId: id,
        securityId: security.id,
        lotId: null,
        action: "buy",
        sharesMicros: 0,
        priceMicros: 0,
        feesCents: 0,
        accountId: null,
        splitNumerator: null,
        splitDenominator: null,
        security,
        ...investmentSplit,
      },
    ],
  });

  /** A cash movement with no investment splits: transfer in from Checking. */
  const cashTransfer = (id: number, amount: number): TransactionWithSplits => ({
    ...baseTransaction,
    id,
    bookId: 1,
    description: "Transfer",
    payee: {
      id: 5,
      bookId: 1,
      name: "Transfer",
      createdAt: new Date(),
    },
    splits: [
      {
        id: id * 10 + 1,
        bookId: 1,
        transactionId: id,
        accountId: 11,
        amount,
        account: plainAccount(11),
      },
      {
        id: id * 10 + 2,
        bookId: 1,
        transactionId: id,
        accountId: 1,
        amount: -amount,
        account: plainAccount(1),
      },
    ],
  });

  const renderRegister = (transactions: TransactionWithSplits[]) =>
    render(
      <TransactionList
        transactions={transactions}
        accounts={mockAccounts}
        selectedAccountId={10}
        balanceAccountId={11}
        onEdit={vi.fn()}
      />
    );

  it("replaces the Payee column with Activity, Shares, and Price headers", () => {
    renderRegister([cashTransfer(4, 500000)]);

    expect(screen.getByRole("columnheader", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Shares" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Price" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Payee" })).not.toBeInTheDocument();
  });

  it("keeps the standard Payee column when not viewing an investment account", () => {
    render(
      <TransactionList
        transactions={[cashTransfer(4, 500000)]}
        accounts={mockAccounts}
        selectedAccountId={1}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByRole("columnheader", { name: "Payee" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Shares" })).not.toBeInTheDocument();
  });

  it("puts a buy's symbol, share count, and price in separate cells", () => {
    renderRegister([
      investmentTransaction(1, -202751, {
        action: "buy",
        sharesMicros: 66_000_000,
        priceMicros: 30_720_000,
      }),
    ]);

    const cells = screen.getByRole("row", { name: /ACME/ }).querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("BUY");
    expect(cells[1]).toHaveTextContent("ACME");
    expect(cells[2]).toHaveTextContent("66");
    expect(cells[3]).toHaveTextContent("$30.72");
  });

  it("dashes shares and price for a cash dividend", () => {
    renderRegister([
      investmentTransaction(2, 4120, {
        action: "dividend",
        sharesMicros: 0,
        priceMicros: 0,
      }),
    ]);

    const cells = screen.getByRole("row", { name: /ACME/ }).querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("DIV");
    expect(cells[2]).toHaveTextContent("—");
    expect(cells[3]).toHaveTextContent("—");
    expect(cells[3]).not.toHaveTextContent("$0.00");
  });

  it("shows a stock split's ratio with dashed shares and price", () => {
    renderRegister([
      investmentTransaction(3, 0, {
        action: "split",
        sharesMicros: 0,
        priceMicros: 0,
        splitNumerator: 2,
        splitDenominator: 1,
      }),
    ]);

    const cells = screen.getByRole("row", { name: /ACME/ }).querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("SPLIT");
    expect(cells[1]).toHaveTextContent("2-for-1");
    expect(cells[2]).toHaveTextContent("—");
    expect(cells[3]).toHaveTextContent("—");
  });

  it("renders a cash transfer with its counterparty account and no share data", () => {
    renderRegister([cashTransfer(4, 500000)]);

    const cells = screen.getByRole("row", { name: /Checking/ }).querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("Checking");
    expect(cells[2]).toHaveTextContent("—");
    expect(cells[3]).toHaveTextContent("—");
  });

  /** A pending Plaid row, as the sync route synthesizes it: the merchant lives
   *  only in `payee`, while `plaidCategory` holds a generic bucket. */
  const plaidPending = (): DisplayTransaction => ({
    ...baseTransaction,
    id: -1000000001,
    bookId: 1,
    description: "STARBUCKS #1234",
    payee: {
      id: -1000000001,
      bookId: 1,
      name: "Starbucks",
      createdAt: new Date(),
    },
    splits: [
      {
        id: -1000000001,
        bookId: 1,
        transactionId: -1000000001,
        accountId: 11,
        amount: -2500,
        account: plainAccount(11),
      },
    ],
    isPlaidPending: true,
    plaidCategory: "Food And Drink",
  });

  it("keeps the merchant visible on a pending Plaid row", () => {
    render(
      <TransactionList
        transactions={[plaidPending()]}
        accounts={mockAccounts}
        selectedAccountId={10}
        balanceAccountId={11}
        onEdit={vi.fn()}
      />
    );

    // The merchant is the only thing identifying the row; "Food And Drink"
    // alone cannot tell one pending charge from another.
    const activity = screen.getByRole("row", { name: /Starbucks/ })
      .querySelectorAll("td")[1];
    expect(activity).toHaveTextContent("Starbucks");
    expect(activity).toHaveTextContent("Food And Drink");
  });

  it("falls back to a placeholder when a pending row has no merchant", () => {
    const row = plaidPending();
    row.payee = null;
    row.plaidCategory = null;

    render(
      <TransactionList
        transactions={[row]}
        accounts={mockAccounts}
        selectedAccountId={10}
        balanceAccountId={11}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText("Unmatched bank transaction")).toBeInTheDocument();
  });

  it("lets a long payee truncate instead of overrunning the Shares column", () => {
    const transfer = cashTransfer(4, 500000);
    transfer.payee = {
      id: 9,
      bookId: 1,
      name: "A very long payee name that would otherwise run past the activity column",
      createdAt: new Date(),
    };

    renderRegister([transfer]);

    const activity = screen
      .getByRole("row", { name: /Checking/ })
      .querySelectorAll("td")[1];
    const note = [...activity.querySelectorAll("span")].find((s) =>
      s.textContent?.includes("very long payee")
    )!;
    // Unbounded (flex-shrink-0 + whitespace-nowrap) it would spill into the
    // fixed-width Shares/Price columns; it has to be able to give way.
    expect(note).not.toHaveClass("flex-shrink-0");
    expect(note).toHaveClass("truncate");
    expect(activity).toHaveClass("overflow-hidden");
  });

  it("tags a cash transfer as XFER rather than a bare direction glyph", () => {
    renderRegister([cashTransfer(4, 500000)]);

    const activity = screen
      .getByRole("row", { name: /Checking/ })
      .querySelectorAll("td")[1];
    expect(activity).toHaveTextContent("XFER");
    // The tag column keeps every row aligned; the signed amount carries direction,
    // so the +/− glyph the bank register uses would be redundant here.
    expect(activity.textContent).not.toMatch(/[+−]/);
  });

  it("renders a buy amount neutral but a transfer amount directional", () => {
    renderRegister([
      investmentTransaction(1, -202751, {
        action: "buy",
        sharesMicros: 66_000_000,
        priceMicros: 30_720_000,
      }),
      cashTransfer(4, 500000),
    ]);

    const buyAmount = screen.getByRole("row", { name: /ACME/ }).querySelectorAll("td")[4];
    const transferAmount = screen
      .getByRole("row", { name: /Checking/ })
      .querySelectorAll("td")[4];

    expect(buyAmount).not.toHaveClass("text-fg-danger");
    expect(buyAmount).toHaveClass("text-fg");
    expect(transferAmount).toHaveClass("text-fg-success");
  });

  it("renders a single share without pluralizing", () => {
    renderRegister([
      investmentTransaction(5, -3072, {
        action: "buy",
        sharesMicros: 1_000_000,
        priceMicros: 30_720_000,
      }),
    ]);

    expect(screen.queryByText(/1 shares/)).not.toBeInTheDocument();
  });

  it("folds the payee into the Activity cell beside the counterparty account", () => {
    renderRegister([cashTransfer(4, 500000)]);

    const activity = screen
      .getByRole("row", { name: /Checking/ })
      .querySelectorAll("td")[1];
    // Both facts live in one cell now — the counterparty and the payee label.
    expect(activity).toHaveTextContent("Checking");
    expect(activity).toHaveTextContent("Transfer");
  });

  it("puts the payee on the same line as the subject, not adrift below it", () => {
    renderRegister([cashTransfer(4, 500000)]);

    const activity = screen
      .getByRole("row", { name: /Checking/ })
      .querySelectorAll("td")[1];
    // Placement, not just presence: a payee rendered as a sibling of the <ul>
    // wraps onto its own line and indents to neither the tag nor the subject
    // column. Living inside the line's <li> is what keeps it aligned.
    const lines = [...activity.querySelectorAll("li")];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("Transfer");
  });

  it("attaches the payee to the last line when a transaction has several", () => {
    const reinvestment = investmentTransaction(6, -10000, {
      action: "buy",
      sharesMicros: 2_000_000,
      priceMicros: 5_000_000,
    });
    reinvestment.payee = {
      id: 7,
      bookId: 1,
      name: "Schwab",
      createdAt: new Date(),
    };
    reinvestment.investmentSplits.push({
      id: 602,
      bookId: 1,
      transactionId: 6,
      securityId: security.id,
      lotId: null,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
      feesCents: 0,
      accountId: null,
      splitNumerator: null,
      splitDenominator: null,
      security,
    });

    renderRegister([reinvestment]);

    const lines = [
      ...screen
        .getByRole("row", { name: /ACME/ })
        .querySelectorAll("td")[1]
        .querySelectorAll("li"),
    ];
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toHaveTextContent("Schwab");
    expect(lines[1]).toHaveTextContent("Schwab");
  });

  it("omits an absent payee instead of rendering 'Unassigned' filler", () => {
    renderRegister([
      investmentTransaction(1, -202751, {
        action: "buy",
        sharesMicros: 66_000_000,
        priceMicros: 30_720_000,
      }),
    ]);

    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });

  it("stacks shares and price per split when a transaction has several", () => {
    const reinvestment = investmentTransaction(6, -10000, {
      action: "buy",
      sharesMicros: 2_000_000,
      priceMicros: 5_000_000,
    });
    reinvestment.investmentSplits.push({
      id: 602,
      bookId: 1,
      transactionId: 6,
      securityId: security.id,
      lotId: null,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
      feesCents: 0,
      accountId: null,
      splitNumerator: null,
      splitDenominator: null,
      security,
    });

    renderRegister([reinvestment]);

    const cells = screen.getByRole("row", { name: /ACME/ }).querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("BUY");
    expect(cells[1]).toHaveTextContent("DIV");
    expect(cells[2].querySelectorAll("li")).toHaveLength(2);
    expect(cells[3].querySelectorAll("li")).toHaveLength(2);
  });
});

describe("TransactionList category icons", () => {
  // Automobile carries its own icon; Gasoline inherits it. Household carries
  // none, so Utilities (its child) falls back to the full path. Dining carries
  // its own icon with no parent, so its full path and leaf name are the same
  // string — a case worth covering separately from the inherited one.
  const iconAccounts: AccountWithBalance[] = [
    {
      id: 300,
      bookId: 1,
      name: "Checking",
      type: "asset",
      subtype: "bank",
      parentId: null,
      isActive: true,
      isInvestmentCash: false,
      icon: null,
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 301,
      bookId: 1,
      name: "Savings",
      type: "asset",
      subtype: "bank",
      parentId: null,
      isActive: true,
      isInvestmentCash: false,
      icon: null,
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 302,
      bookId: 1,
      name: "Automobile",
      type: "expense",
      subtype: null,
      parentId: null,
      isActive: true,
      isInvestmentCash: false,
      icon: "🚗",
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 303,
      bookId: 1,
      name: "Gasoline",
      type: "expense",
      subtype: null,
      parentId: 302,
      isActive: true,
      isInvestmentCash: false,
      icon: null,
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 304,
      bookId: 1,
      name: "Household",
      type: "expense",
      subtype: null,
      parentId: null,
      isActive: true,
      isInvestmentCash: false,
      icon: null,
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 305,
      bookId: 1,
      name: "Utilities",
      type: "expense",
      subtype: null,
      parentId: 304,
      isActive: true,
      isInvestmentCash: false,
      icon: null,
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 306,
      bookId: 1,
      name: "Dining",
      type: "expense",
      subtype: null,
      parentId: null,
      isActive: true,
      isInvestmentCash: false,
      icon: "🍔",
      isFavorite: false,
      balance: 0,
      hasTransactions: true,
      children: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const plainAccount = (id: number) => {
    const found = iconAccounts.find((a) => a.id === id)!;
    const { balance, hasTransactions, children, ...account } = found;
    void balance;
    void hasTransactions;
    void children;
    return account;
  };

  /** A transaction with one split per (accountId, amount) pair, built against iconAccounts. */
  const iconTransaction = (
    id: number,
    description: string,
    splitDefs: Array<{ accountId: number; amount: number }>
  ): TransactionWithSplits => ({
    ...baseTransaction,
    id,
    bookId: 1,
    description,
    splits: splitDefs.map((def, index) => ({
      id: id * 10 + index + 1,
      bookId: 1,
      transactionId: id,
      accountId: def.accountId,
      amount: def.amount,
      account: plainAccount(def.accountId),
    })),
  });

  const renderIconRow = (
    transactions: TransactionWithSplits[],
    selectedAccountId: number | null = null
  ) =>
    render(
      <TransactionList
        transactions={transactions}
        accounts={iconAccounts}
        selectedAccountId={selectedAccountId}
        onEdit={vi.fn()}
      />
    );

  it("shows the icon and leaf name for a category with a resolvable icon, with the full path as a title", () => {
    renderIconRow([
      iconTransaction(9001, "Fill up", [
        { accountId: 300, amount: -4000 },
        { accountId: 303, amount: 4000 },
      ]),
    ]);

    // The icon renders as its own text node, per CategoryIcon's contract.
    expect(screen.getByText("🚗")).toBeInTheDocument();

    // Leaf name only, with the full path as the hover tooltip.
    const categoryLabel = screen.getByText("Gasoline");
    expect(categoryLabel).toHaveAttribute("title", "Automobile : Gasoline");
    expect(screen.queryByText("Automobile : Gasoline")).not.toBeInTheDocument();

    // The asset side is out of scope and keeps its plain display.
    const assetLabel = screen.getByText("Checking");
    expect(assetLabel).not.toHaveAttribute("title");
    expect(assetLabel.children).toHaveLength(0);
  });

  it("shows the full hierarchy path with no glyph for a category with no icon", () => {
    renderIconRow([
      iconTransaction(9002, "Electric bill", [
        { accountId: 300, amount: -5000 },
        { accountId: 305, amount: 5000 },
      ]),
    ]);

    // The un-migrated case: text is already the full path, so it renders
    // exactly as it did before this feature — and CategoryIcon renders
    // nothing for a null icon, so the label has no child element at all.
    const categoryLabel = screen.getByText("Household : Utilities");
    expect(categoryLabel).toHaveAttribute("title", "Household : Utilities");
    expect(categoryLabel.children).toHaveLength(0);

    // The asset side is unchanged here too.
    const assetLabel = screen.getByText("Checking");
    expect(assetLabel).not.toHaveAttribute("title");
    expect(assetLabel.children).toHaveLength(0);
  });

  it("renders a transfer row with no icon at all", () => {
    renderIconRow([
      iconTransaction(9003, "Move money", [
        { accountId: 300, amount: -2000 },
        { accountId: 301, amount: 2000 },
      ]),
    ]);

    // A transfer is two asset/liability accounts — no category lookup applies
    // to either side, and renderTransferTransaction is untouched by this task.
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
    expect(screen.queryByText("🚗")).not.toBeInTheDocument();
    expect(screen.queryByText("🍔")).not.toBeInTheDocument();
  });

  it("shows a glyph on each category line of a multi-split row, and keeps the bank line's full path with no glyph", () => {
    renderIconRow([
      iconTransaction(9004, "Errand run", [
        { accountId: 300, amount: -6000 },
        { accountId: 303, amount: 4000 },
        { accountId: 306, amount: 2000 },
      ]),
    ]);

    // Both category lines carry a glyph...
    expect(screen.getByText("🚗")).toBeInTheDocument();
    expect(screen.getByText("🍔")).toBeInTheDocument();
    expect(screen.getByText("Gasoline")).toHaveAttribute("title", "Automobile : Gasoline");
    // Dining has no parent, so its leaf name and full path happen to be the
    // same string — still exercised as the icon-carrying, non-inherited case.
    expect(screen.getByText("Dining")).toHaveAttribute("title", "Dining");

    // ...but the bank-account line in the same list is a lookup miss and
    // keeps its plain full-path display with no glyph.
    const bankLabel = screen.getByText("Checking");
    expect(bankLabel).not.toHaveAttribute("title");
    expect(bankLabel.children).toHaveLength(0);
  });

  it("shows the icon in the selected-account view (renderAccounts), the branch used when a checking account is selected", () => {
    renderIconRow(
      [
        iconTransaction(9005, "Fill up", [
          { accountId: 300, amount: -4000 },
          { accountId: 303, amount: 4000 },
        ]),
      ],
      300
    );

    expect(screen.getByText("🚗")).toBeInTheDocument();
    expect(screen.getByText("Gasoline")).toHaveAttribute("title", "Automobile : Gasoline");
    // The selected account itself isn't listed as a counterpart line.
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
  });
});
