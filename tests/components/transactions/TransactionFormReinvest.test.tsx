import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  type: AccountWithBalance["type"],
  extra: Partial<AccountWithBalance> = {}
): AccountWithBalance => ({
  id,
  bookId: 1,
  name,
  type,
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
  ...extra,
});

const brokerage = account(1, "Brokerage", "asset", { subtype: "investment" });
const cash = account(2, "Brokerage Cash", "asset", { subtype: "cash", parentId: 1, isInvestmentCash: true });
const dividends = account(3, "Dividend Income", "income");
const fees = account(4, "Investment Fees", "expense");
const accounts = [brokerage, cash, dividends, fees];

/** A saved DRIP: $100.00 buys 1.5 shares at $65.00, a $1.00 fee, $1.50 cash rest. */
function savedReinvestment(
  splits: Array<[AccountWithBalance, number]>,
  feesCents = 100
): TransactionWithSplits {
  return {
    id: 123,
    bookId: 1,
    date: "2026-02-02",
    description: "DRIP",
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
    splits: splits.map(([splitAccount, amount], index) => ({
      id: index + 1,
      bookId: 1,
      transactionId: 123,
      accountId: splitAccount.id,
      amount,
      account: splitAccount,
    })),
    investmentSplits: [
      {
        id: 1, bookId: 1, transactionId: 123, securityId: 10, accountId: 1, action: "dividend",
        sharesMicros: 0, priceMicros: 0, feesCents: 0, splitNumerator: null, splitDenominator: null,
      },
      {
        id: 2, bookId: 1, transactionId: 123, securityId: 10, accountId: 1, action: "buy",
        sharesMicros: 1_500_000, priceMicros: 65_000_000, feesCents, splitNumerator: null, splitDenominator: null,
      },
    ],
  };
}

const formSplits: Array<[AccountWithBalance, number]> = [
  [brokerage, 9750], [fees, 100], [dividends, -10000], [cash, 150],
];

describe("TransactionForm Dividend Reinvest", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: 10, name: "Acme Corp", symbol: "ACME", securityType: "stock" }],
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderForm = (editingTransaction?: TransactionWithSplits) => {
    const onSubmit = vi.fn();
    render(
      <ToastProvider>
        <TransactionForm
          accounts={accounts}
          selectedAccountId={1}
          isInvestmentAccountSelected
          onSubmit={onSubmit}
          editingTransaction={editingTransaction}
        />
      </ToastProvider>
    );
    return { onSubmit };
  };

  const chooseSecurity = async () => {
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/b/1/securities", expect.objectContaining({ method: "GET" }))
    );
    fireEvent.focus(screen.getByLabelText("Security"));
    const option = await waitFor(() => {
      const found = screen.getAllByRole("button").find((button) => button.textContent?.includes("ACME"));
      expect(found).toBeDefined();
      return found!;
    });
    fireEvent.click(option);
  };

  const enterReinvest = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Investment" }));
    await chooseSecurity();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "reinvest" } });
  };

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  const submit = () =>
    fireEvent.submit(screen.getByRole("button", { name: "Add Transaction" }).closest("form")!);

  it("saves one transaction with a dividend split and a buy split", async () => {
    const { onSubmit } = renderForm();
    await enterReinvest();
    expect(screen.getByLabelText("Income Account")).toBeInTheDocument();
    expect(screen.getByLabelText("Fee/Expense Account")).toBeInTheDocument();
    type("Dividend Amount", "100.00");
    type("Shares", "1.5");
    type("Price", "65");
    type("Fee", "1.00");
    expect(screen.getByTestId("investment-remainder")).toHaveTextContent("$1.50");
    submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.splits).toEqual([
      { accountId: 1, amount: 9750 },
      { accountId: 4, amount: 100 },
      { accountId: 3, amount: -10000 },
      { accountId: 2, amount: 150 },
    ]);
    expect(payload.investmentSplits).toEqual([
      { securityId: 10, action: "dividend", sharesMicros: 0, priceMicros: 0, feesCents: 0 },
      { securityId: 10, action: "buy", sharesMicros: 1_500_000, priceMicros: 65_000_000, feesCents: 100 },
    ]);
  });

  it("fills the price from the dividend, the fee and the shares until a price is typed", async () => {
    const { onSubmit } = renderForm();
    await enterReinvest();
    type("Dividend Amount", "100.00");
    type("Shares", "3");
    // ($100.00 - $0) / 3 rounded down to micros.
    await waitFor(() => expect(screen.getByLabelText("Price")).toHaveValue("33.333333"));
    type("Fee", "1.00");
    await waitFor(() => expect(screen.getByLabelText("Price")).toHaveValue("33"));
    expect(screen.getByTestId("investment-remainder")).toHaveTextContent("$0.00");

    // A typed price stays when the inputs change.
    type("Price", "30");
    type("Shares", "2");
    expect(screen.getByLabelText("Price")).toHaveValue("30");
    submit();
    expect(onSubmit.mock.calls[0][0].splits).toEqual([
      { accountId: 1, amount: 6000 },
      { accountId: 4, amount: 100 },
      { accountId: 3, amount: -10000 },
      { accountId: 2, amount: 3900 },
    ]);
  });

  it("refuses a negative cash remainder", async () => {
    const { onSubmit } = renderForm();
    await enterReinvest();
    type("Dividend Amount", "100.00");
    type("Shares", "2");
    // 2 x $50.25 = $100.50, more than the dividend.
    type("Price", "50.25");
    expect(screen.getByTestId("investment-remainder")).toHaveTextContent("$0.50");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("The shares and the fee cost more than the dividend")).toBeInTheDocument();
  });

  it("refuses a negative fee with a message, not an error", async () => {
    const { onSubmit } = renderForm();
    await enterReinvest();
    type("Dividend Amount", "100.00");
    type("Shares", "1");
    type("Price", "50");
    type("Fee", "-1");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("The fee must not be negative")).toBeInTheDocument();
  });

  it("keeps the form usable when the dividend is too large to compute a price", async () => {
    const { onSubmit } = renderForm();
    await enterReinvest();
    type("Shares", "1");
    type("Dividend Amount", "1000000000000000000");
    expect(screen.getByLabelText("Price")).toHaveValue("");
    type("Dividend Amount", "100.00");
    await waitFor(() => expect(screen.getByLabelText("Price")).toHaveValue("100"));
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("opens a saved reinvestment as Dividend Reinvest and saves the same rows", async () => {
    const saved = savedReinvestment(formSplits);
    const { onSubmit } = renderForm(saved);
    await waitFor(() => expect(screen.getByLabelText("Action")).toHaveValue("reinvest"));
    expect(screen.getByLabelText("Dividend Amount")).toHaveValue("100.00");
    expect(screen.getByLabelText("Shares")).toHaveValue("1.5");
    expect(screen.getByLabelText("Price")).toHaveValue("65");
    expect(screen.getByLabelText("Fee")).toHaveValue("1.00");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    const sort = (splits: Array<{ accountId: number; amount: number }>) =>
      [...splits].sort((a, b) => a.accountId - b.accountId);
    expect(sort(payload.splits)).toEqual(sort(saved.splits.map(({ accountId, amount }) => ({ accountId, amount }))));
    expect(payload.investmentSplits).toEqual([
      { securityId: 10, action: "dividend", sharesMicros: 0, priceMicros: 0, feesCents: 0 },
      { securityId: 10, action: "buy", sharesMicros: 1_500_000, priceMicros: 65_000_000, feesCents: 100 },
    ]);
  });

  // An imported reinvestment keeps its fee in the investment leg. The form
  // would save a fee leg, so it opens in journal mode and keeps the splits.
  it("opens a reinvestment that the form would change in journal mode", async () => {
    const imported = savedReinvestment([[brokerage, 9850], [dividends, -10000], [cash, 150]]);
    const { onSubmit } = renderForm(imported);
    await waitFor(() => expect(screen.queryByLabelText("Action")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].investmentSplits).toBeUndefined();
  });
});
