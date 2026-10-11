// Investment mode shows one investment split, and its save replaces all the
// investment splits of the transaction. These tests prove that a transaction
// with more than one investment split opens in journal mode, and that its save
// sends no investment splits, so the server keeps the splits it has.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance, TransactionWithSplits } from "@/types";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/transactions",
  })
);

const account = (
  id: number,
  name: string,
  overrides: Partial<AccountWithBalance>
): AccountWithBalance => ({
  id,
  bookId: 1,
  name,
  type: "asset",
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
  ...overrides,
});

const brokerage = account(1, "Brokerage", { subtype: "investment" });
const brokerageCash = account(2, "Brokerage Cash", {
  subtype: "cash",
  parentId: 1,
  isInvestmentCash: true,
});
const dividends = account(3, "Dividends", { type: "income" });
const accounts = [brokerage, brokerageCash, dividends];

const investmentSplit = (
  id: number,
  action: "buy" | "dividend",
  sharesMicros: number,
  priceMicros: number,
  feesCents = 0
) => ({
  id,
  bookId: 1,
  transactionId: 9,
  accountId: 1,
  securityId: 10,
  action,
  sharesMicros,
  priceMicros,
  feesCents,
  splitNumerator: null,
  splitDenominator: null,
});

// An imported reinvested dividend: 2 shares at 50.00 and a 1.00 fee bought
// with a 101.00 dividend, in one transaction. The import keeps the fee in the
// investment leg, so Dividend Reinvest would save other legs (a fee leg), and
// the form opens it in journal mode.
const reinvested: TransactionWithSplits = {
  id: 9,
  bookId: 1,
  date: "2024-07-01",
  description: "AAA Reinvested",
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
    { id: 1, bookId: 1, transactionId: 9, accountId: 1, amount: 10100, account: brokerage },
    { id: 2, bookId: 1, transactionId: 9, accountId: 3, amount: -10100, account: dividends },
  ],
  investmentSplits: [
    investmentSplit(1, "buy", 2_000_000, 50_000_000, 100),
    investmentSplit(2, "dividend", 0, 0),
  ],
};

describe("TransactionForm with more than one investment split", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const editAndSave = async (transaction: TransactionWithSplits) => {
    const onSubmit = vi.fn();
    render(
      <ToastProvider>
        <TransactionForm
          accounts={accounts}
          selectedAccountId={1}
          isInvestmentAccountSelected
          editingTransaction={transaction}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          onDelete={vi.fn()}
          onMakeRecurring={vi.fn()}
        />
      </ToastProvider>
    );
    await waitFor(() => expect(screen.getByDisplayValue(transaction.description!)).toBeInTheDocument());
    return {
      onSubmit,
      save: () => fireEvent.click(screen.getByRole("button", { name: /Save Changes/ })),
    };
  };

  it("opens in journal mode and says that a save keeps the investment splits", async () => {
    await editAndSave(reinvested);

    expect(screen.getByText("Journal Entry")).toBeInTheDocument();
    expect(screen.getByText(/also has 2 investment splits/)).toBeInTheDocument();
    expect(screen.queryByText(/Action/)).not.toBeInTheDocument();
  });

  it("sends no investment splits on a save without change, so none is removed", async () => {
    const { onSubmit, save } = await editAndSave(reinvested);
    save();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.splits).toEqual([
      { accountId: 1, amount: 10100 },
      { accountId: 3, amount: -10100 },
    ]);
    expect(payload.investmentSplits).toBeUndefined();
    // putTransaction sends JSON. Without the key, the server keeps the
    // investment splits of the transaction.
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty("investmentSplits");
  });

  // A recurring rule copies only the ledger splits. A reinvested dividend
  // made recurring would add value and income with no shares.
  it("does not offer Make recurring in journal mode for a transaction with investment splits", async () => {
    await editAndSave(reinvested);

    expect(screen.getByText("Journal Entry")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make recurring/ })).not.toBeInTheDocument();
  });

  it("offers Make recurring for a transaction with no investment split", async () => {
    await editAndSave({ ...reinvested, description: "Plain", investmentSplits: [] });

    expect(screen.getByRole("button", { name: /Make recurring/ })).toBeInTheDocument();
  });

  it("still opens a transaction with one investment split in investment mode", async () => {
    const buy: TransactionWithSplits = {
      ...reinvested,
      description: "AAA Buy",
      splits: [
        { ...reinvested.splits[0], amount: 10000 },
        { id: 2, bookId: 1, transactionId: 9, accountId: 2, amount: -10000, account: brokerageCash },
      ],
      investmentSplits: [investmentSplit(1, "buy", 2_000_000, 50_000_000)],
    };
    const { onSubmit, save } = await editAndSave(buy);

    expect(screen.queryByText("Journal Entry")).not.toBeInTheDocument();
    expect(screen.queryByText(/also has/)).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The form loaded this one split, so it may replace it.
    expect(onSubmit.mock.calls[0][0].investmentSplits).toHaveLength(1);
  });
});
