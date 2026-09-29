import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance, PlaidLinkData } from "@/types";

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/transactions",
  })
);

const accounts: AccountWithBalance[] = [
  {
    id: 3,
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
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 4,
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
    balance: 0,
    hasTransactions: true,
  },
];

const editingTransaction = {
  id: 99,
  bookId: 1,
  date: "2024-06-10",
  description: "Lunch",
  checkNumber: null,
  notes: null,
  payeeId: null,
  isReconciled: false,
  isFloating: false,
  recurringRuleId: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  payee: null,
  splits: [
    {
      id: 1,
      bookId: 1,
      transactionId: 99,
      accountId: 4,
      amount: 1250,
      account: accounts[1],
    },
    {
      id: 2,
      bookId: 1,
      transactionId: 99,
      accountId: 3,
      amount: -1250,
      account: accounts[0],
    },
  ],
  investmentSplits: [],
};

const plaidData: PlaidLinkData = {
  id: 1,
  plaidTransactionId: "plaid-tx-1",
  date: "2024-06-10",
  authorizedDate: null,
  amountCents: 1250,
  name: "Corner Store",
  merchantName: null,
  originalDescription: null,
  pending: false,
  isoCurrencyCode: "USD",
  categoryPrimary: null,
  categoryDetailed: null,
  rawJson: "{}",
};

describe("TransactionForm readOnly", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disables the fields and shows only Close", async () => {
    const onCancel = vi.fn();
    renderWithToast(
      <TransactionForm
        accounts={accounts}
        selectedAccountId={null}
        editingTransaction={editingTransaction}
        onSubmit={vi.fn()}
        onCancel={onCancel}
        onDelete={vi.fn()}
        onMakeRecurring={vi.fn()}
        readOnly
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByDisplayValue(editingTransaction.description!)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make recurring/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("hides the Plaid unlink action for a viewer", async () => {
    renderWithToast(
      <TransactionForm
        accounts={accounts}
        selectedAccountId={null}
        editingTransaction={editingTransaction}
        plaidData={plaidData}
        onPlaidUnlinked={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onMakeRecurring={vi.fn()}
        readOnly
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Expand the banner's details, where the unlink button would otherwise be.
    fireEvent.click(screen.getByText("Linked to Plaid"));
    expect(screen.getByText(plaidData.plaidTransactionId)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Unlink from Plaid/ })
    ).not.toBeInTheDocument();
  });
});
