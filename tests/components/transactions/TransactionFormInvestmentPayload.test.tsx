// This file deliberately duplicates the harness (renderWithToast,
// vi.mock("next/navigation", ...), mockAccounts, the fetchMock beforeEach/
// afterEach, setup(), and enterInvestmentMode()) from
// TransactionFormInvestment.test.tsx instead of importing it.
//
// This is a gate: a later task verifies this file's integrity by checking
// that `git log` shows exactly one commit touching it. If it imported a
// shared fixture module, someone could change that fixture and silently
// change what this gate asserts while this file itself stayed untouched,
// and the integrity check would still pass. Self-containment is what makes
// the check mean something. Do not "fix" this duplication — it is
// deliberate. The two files are allowed to drift apart.
//
// These six tests pin the exact `splits` / `investmentSplits` payload
// TransactionForm's handleSubmit produces today for each investment action
// (buy, sell, dividend, capGain, fee, split), using toStrictEqual — not
// toEqual, and not objectContaining. toEqual treats an undefined-valued key
// (e.g. `splitNumerator: undefined`) as equal to that key being absent, so it
// would silently pass a refactor that adds or drops an undefined-valued key;
// toStrictEqual requires the key sets to match exactly. Every value below,
// including the explicit `undefined`s, is therefore load-bearing: it asserts
// the real payload shape, not just the defined subset of it. See
// task-1-report.md for the hand verification of each payload before it was
// encoded here, and for the mutation evidence that these assertions actually
// discriminate on `splits`/`investmentSplits` rather than merely on whether
// onSubmit was called.
//
// Coverage gap: TransactionForm renders two different investment JSX trees
// gated by its `compact` prop (`compact = !fullLayout && !editingTransaction`).
// Every test here uses default props (no `fullLayout`, no `editingTransaction`),
// so only the compact branch is exercised — same as the existing
// TransactionFormInvestment.test.tsx suite. The full/desktop branch (a
// separate JSX tree with different labels, e.g. "Investment Account" instead
// of "Inv. Account") is untested by this file. A later task collapsing the
// two investment JSX trees into one component must account for both label
// sets; this gate cannot see whether that collapse preserves the desktop
// branch's behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance } from "@/types";

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/transactions",
}));

const mockAccounts: AccountWithBalance[] = [
  {
    id: 1,
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
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 2,
    bookId: 1,
    name: "Brokerage Cash",
    type: "asset",
    subtype: "cash",
    parentId: 1,
    isActive: true,
    isInvestmentCash: true,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 3,
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
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 4,
    bookId: 1,
    name: "Investment Fees",
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
  {
    id: 5,
    bookId: 1,
    name: "Retirement",
    type: "asset",
    subtype: "investment",
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
    id: 6,
    bookId: 1,
    name: "Retirement Cash",
    type: "asset",
    subtype: "cash",
    parentId: 5,
    isActive: true,
    isInvestmentCash: true,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
];

const setup = () => {
  const onSubmit = vi.fn();
  renderWithToast(
    <TransactionForm accounts={mockAccounts} selectedAccountId={null} isInvestmentAccountSelected onSubmit={onSubmit} />
  );
  return { onSubmit };
};

describe("TransactionForm investment payload characterization", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 10, name: "Acme Corp", symbol: "ACME", securityType: "stock" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    // The payload carries `date`, which defaults to today's date. Freeze it, or
    // every expectation below rots overnight. Only Date is faked: bare fake
    // timers break the timers waitFor depends on.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const enterInvestmentMode = async () => {
    // Click the Investment tab
    fireEvent.click(screen.getByRole("button", { name: "Investment" }));

    // Wait for securities to load
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/securities",
        expect.objectContaining({ method: "GET" })
      );
    });

    // Open the security autocomplete dropdown by focusing the input
    const securityInput = screen.getByLabelText("Security");
    fireEvent.focus(securityInput);

    // Wait for the dropdown to appear and click the security option
    await waitFor(() => {
      const buttons = screen.queryAllByRole("button");
      const securityButton = buttons.find(btn => btn.textContent?.includes("ACME"));
      expect(securityButton).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole("button");
    const securityButton = buttons.find(btn => btn.textContent?.includes("ACME"));
    fireEvent.click(securityButton!);
  };

  it("pins the payload for a buy", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // buy — 100 shares @ $50.00, $5.00 fee
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "buy" } });
    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "5.00" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 1, amount: 500000 },
        { accountId: 4, amount: 500 },
        { accountId: 2, amount: -500500 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "buy",
          sharesMicros: 100000000,
          priceMicros: 50000000,
          feesCents: 500,
          splitNumerator: undefined,
          splitDenominator: undefined,
        },
      ],
    });
  });

  it("pins the payload for a sell", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // sell — 40 shares @ $55.00, $5.00 fee
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "sell" } });
    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "55.00" } });
    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "5.00" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 2, amount: 219500 },
        { accountId: 4, amount: 500 },
        { accountId: 1, amount: -220000 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "sell",
          sharesMicros: 40000000,
          priceMicros: 55000000,
          feesCents: 500,
          splitNumerator: undefined,
          splitDenominator: undefined,
        },
      ],
    });
  });

  it("pins the payload for a dividend", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // dividend — $12.34, Income Account = "Dividend Income"
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "dividend" } });
    fireEvent.change(screen.getByLabelText("Dividend Amount"), { target: { value: "12.34" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 2, amount: 1234 },
        { accountId: 3, amount: -1234 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "dividend",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          splitNumerator: undefined,
          splitDenominator: undefined,
        },
      ],
    });
  });

  it("pins the payload for a capGain", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // capGain — $56.78
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "capGain" } });
    fireEvent.change(screen.getByLabelText("Capital Gain Amount"), { target: { value: "56.78" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 2, amount: 5678 },
        { accountId: 3, amount: -5678 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "capGain",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          splitNumerator: undefined,
          splitDenominator: undefined,
        },
      ],
    });
  });

  it("pins the payload for a fee", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // fee — $9.99
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "fee" } });
    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "9.99" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 4, amount: 999 },
        { accountId: 2, amount: -999 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "fee",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 999,
          splitNumerator: undefined,
          splitDenominator: undefined,
        },
      ],
    });
  });

  it("pins the payload for a split", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // split — 2:1
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Split Numerator"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Split Denominator"), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toStrictEqual({
      date: "2026-03-15",
      description: "",
      payeeName: "",
      isReconciled: false,
      isFloating: false,
      splits: [
        { accountId: 1, amount: 0 },
        { accountId: 2, amount: 0 },
      ],
      investmentSplits: [
        {
          securityId: 10,
          action: "split",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          splitNumerator: 2,
          splitDenominator: 1,
        },
      ],
    });
  });
});
