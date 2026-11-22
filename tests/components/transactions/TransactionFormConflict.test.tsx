import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { TRANSACTION_EDIT_CONFLICT_MESSAGE } from "@/lib/transaction-requests";
import type { AccountWithBalance, PlaidLinkData } from "@/types";

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

describe("TransactionForm after a revision conflict", () => {
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

  const form = (props: { conflict: boolean; onSubmit?: () => void; onReloadLatest?: () => void; transaction?: typeof editingTransaction }) => (
    <ToastProvider>
      <TransactionForm
        accounts={accounts}
        selectedAccountId={null}
        editingTransaction={props.transaction ?? editingTransaction}
        onSubmit={props.onSubmit ?? vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onMakeRecurring={vi.fn()}
        conflict={props.conflict}
        onReloadLatest={props.onReloadLatest}
      />
    </ToastProvider>
  );

  it("keeps the user's edits, blocks the writes, and offers a reload", async () => {
    const onSubmit = vi.fn();
    const onReloadLatest = vi.fn();
    const { rerender, container } = render(form({ conflict: false, onSubmit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByDisplayValue("Lunch"), { target: { value: "Lunch with Sam" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The page sets `conflict` after the server refuses the save.
    rerender(form({ conflict: true, onSubmit, onReloadLatest }));

    expect(screen.getByRole("alert")).toHaveTextContent(TRANSACTION_EDIT_CONFLICT_MESSAGE);
    // The edit is still in the field, and the user can select and copy it.
    expect(screen.getByDisplayValue("Lunch with Sam")).toBeEnabled();
    expect(screen.getByRole("button", { name: /Save Changes/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Make recurring/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    // Enter in a field also submits the form. It must not send the stale edits.
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect(onReloadLatest).toHaveBeenCalledTimes(1);
  });

  // An unlink makes the page load the transaction again, which replaces the
  // edits that the form kept.
  it("hides the Plaid unlink action during the conflict", async () => {
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
    const linked = (conflict: boolean) => (
      <ToastProvider>
        <TransactionForm
          accounts={accounts}
          selectedAccountId={null}
          editingTransaction={editingTransaction}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          plaidData={plaidData}
          onPlaidUnlinked={vi.fn()}
          conflict={conflict}
        />
      </ToastProvider>
    );
    const { rerender } = render(linked(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The unlink button is in the banner's details.
    fireEvent.click(screen.getByText("Linked to Plaid"));
    expect(screen.getByRole("button", { name: /Unlink from Plaid/ })).toBeInTheDocument();

    rerender(linked(true));

    expect(screen.getByText(plaidData.plaidTransactionId)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unlink from Plaid/ })).not.toBeInTheDocument();
  });

  it("shows the latest version after the reload", async () => {
    const { rerender } = render(form({ conflict: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue("Lunch"), { target: { value: "My edit" } });

    // The page replaces the transaction with the latest version and ends the conflict.
    const latest = { ...editingTransaction, description: "Changed by another user", updatedAt: new Date() };
    rerender(form({ conflict: false, transaction: latest }));

    expect(screen.getByDisplayValue("Changed by another user")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/ })).toBeEnabled();
  });
});
