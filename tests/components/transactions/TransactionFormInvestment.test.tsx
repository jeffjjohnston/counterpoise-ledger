import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance } from "@/types";
import * as accounting from "@/lib/accounting";

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

describe("TransactionForm investment mode", () => {
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
  });

  afterEach(() => {
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

  it("validates non-negative shares for investment actions", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "10" } });
    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Shares and price are required for this investment action")
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires a price for buy and sell actions", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "" } });
    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Shares and price are required for this investment action")
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submission when investment splits are not balanced", async () => {
    vi.spyOn(accounting, "validateSplits").mockReturnValueOnce(false);
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "10" } });
    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Transaction must be balanced (debits must equal credits)")
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses the investment account's cash account without showing a selector", async () => {
    const buildBuySplitsSpy = vi.spyOn(accounting, "buildBuySplits").mockReturnValue([
      { accountId: 5, amount: 10000 },
      { accountId: 6, amount: -10000 },
    ]);
    const { onSubmit } = setup();
    await enterInvestmentMode();

    expect(screen.queryByLabelText("Cash Account")).not.toBeInTheDocument();

    // Select Retirement account (id: 5) using autocomplete
    const investmentAccountInput = screen.getByLabelText("Inv. Account");
    fireEvent.focus(investmentAccountInput);
    fireEvent.change(investmentAccountInput, { target: { value: "Retirement" } });

    await waitFor(() => {
      const buttons = screen.queryAllByRole("button");
      const retirementButton = buttons.find(btn => btn.textContent?.includes("Retirement"));
      expect(retirementButton).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole("button");
    const retirementButton = buttons.find(btn => btn.textContent?.includes("Retirement"));
    fireEvent.click(retirementButton!);

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "10" } });
    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(buildBuySplitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cashAccountId: 6 })
    );
    expect(onSubmit).toHaveBeenCalled();
  });

  it("shows a real-time total for investment entries", async () => {
    setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "1.25" } });

    expect(screen.getByTestId("investment-total")).toHaveTextContent("$21.25");

    fireEvent.change(screen.getByLabelText("Fee"), { target: { value: "0.50" } });

    expect(screen.getByTestId("investment-total")).toHaveTextContent("$20.50");
  });

  it("evaluates math expressions in the Price field", async () => {
    setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "2" } });
    const priceInput = screen.getByLabelText("Price") as HTMLInputElement;
    fireEvent.change(priceInput, { target: { value: "100/4" } });

    // Total updates as the expression is typed (2 shares * 25 = $50.00)
    expect(screen.getByTestId("investment-total")).toHaveTextContent("$50.00");

    // Blur resolves the displayed value to the computed number
    fireEvent.blur(priceInput);
    expect(priceInput.value).toBe("25");
  });

  it("rejects invalid expressions in the Price field instead of coercing prefixes", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "1" } });
    // "100/" is a malformed expression. parseFloat would silently give 100 —
    // we expect strict rejection, which drives the total to $0.00 and blocks
    // submission with the missing-price alert.
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "100/" } });

    expect(screen.getByTestId("investment-total")).toHaveTextContent("$0.00");

    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Shares and price are required for this investment action")
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits stock splits with the ratio fields", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Split Numerator"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Split Denominator"), {
      target: { value: "1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        investmentSplits: [
          expect.objectContaining({
            action: "split",
            splitNumerator: 2,
            splitDenominator: 1,
            sharesMicros: 0,
            priceMicros: 0,
          }),
        ],
      })
    );
  });

  it("rejects non-integer split ratios", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Split Numerator"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("Split Denominator"), {
      target: { value: "1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));

    expect(await screen.findByText("Split ratio must be whole numbers")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects zero split ratios", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Split Numerator"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Split Denominator"), {
      target: { value: "1" },
    });

    const zeroForm = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(zeroForm!);

    expect(await screen.findByText("Split ratio must be greater than zero")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects negative split ratios", async () => {
    const { onSubmit } = setup();
    await enterInvestmentMode();

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Split Numerator"), {
      target: { value: "-1" },
    });
    fireEvent.change(screen.getByLabelText("Split Denominator"), {
      target: { value: "2" },
    });

    const negativeForm = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(negativeForm!);

    expect(await screen.findByText("Split ratio must be whole numbers")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("derives the investment account from the cash split when editing dividends", async () => {
    const buildDividendSplitsSpy = vi
      .spyOn(accounting, "buildDividendSplits")
      .mockReturnValue([
        { accountId: 6, amount: 10000 },
        { accountId: 3, amount: -10000 },
      ]);

    const onSubmit = vi.fn();
    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={null}
        onSubmit={onSubmit}
        editingTransaction={{
          id: 123,
          bookId: 1,
          date: "2024-05-01",
          description: "Dividend",
          checkNumber: null,
          notes: null,
          payeeId: null,
          isReconciled: false,
          isFloating: false,
          recurringRuleId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          payee: null,
          splits: [
            {
              id: 1,
              bookId: 1,
              transactionId: 123,
              accountId: 6,
              amount: 10000,
              account: mockAccounts[5],
            },
            {
              id: 2,
              bookId: 1,
              transactionId: 123,
              accountId: 3,
              amount: -10000,
              account: mockAccounts[2],
            },
          ],
          investmentSplits: [
            {
              id: 1,
              bookId: 1,
              transactionId: 123,
              securityId: 10,
              accountId: 1,
              lotId: null,
              action: "dividend" as const,
              sharesMicros: 1_000_000,
              priceMicros: 1_000_000,
              feesCents: 0,
              splitNumerator: null,
              splitDenominator: null,
            },
          ],
        }}
      />
    );

    await enterInvestmentMode();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(buildDividendSplitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cashAccountId: 6, incomeAccountId: 3 })
    );
    expect(onSubmit).toHaveBeenCalled();
  });

  it("pre-selects the investment account when selectedAccountId is an investment account", async () => {
    const onSubmit = vi.fn();

    // Render with Brokerage (id: 1) selected
    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={1}
        isInvestmentAccountSelected
        onSubmit={onSubmit}
      />
    );

    await enterInvestmentMode();

    // Check that the Inv. Account input shows "Brokerage"
    const investmentAccountInput = screen.getByLabelText("Inv. Account") as HTMLInputElement;
    expect(investmentAccountInput.value).toBe("Brokerage");
  });

  it("switches to the newly selected investment account when selectedAccountId changes", async () => {
    const onSubmit = vi.fn();

    // Start with Brokerage (id: 1) selected
    const { rerender } = renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={1}
        isInvestmentAccountSelected
        onSubmit={onSubmit}
      />
    );

    await enterInvestmentMode();

    // Verify Brokerage is selected
    let investmentAccountInput = screen.getByLabelText("Inv. Account") as HTMLInputElement;
    expect(investmentAccountInput.value).toBe("Brokerage");

    // Change to Retirement (id: 5)
    rerender(
      <ToastProvider>
        <TransactionForm
          accounts={mockAccounts}
          selectedAccountId={5}
          isInvestmentAccountSelected
          onSubmit={onSubmit}
        />
      </ToastProvider>
    );

    // Need to re-enter investment mode after rerender
    await enterInvestmentMode();

    // Verify Retirement is now selected
    investmentAccountInput = screen.getByLabelText("Inv. Account") as HTMLInputElement;
    expect(investmentAccountInput.value).toBe("Retirement");
  });

  it("allows entering a cash dividend with just an amount", async () => {
    const buildDividendSplitsSpy = vi.spyOn(accounting, "buildDividendSplits").mockReturnValue([
      { accountId: 2, amount: 10000 },
      { accountId: 3, amount: -10000 },
    ]);
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // Change action to dividend
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "dividend" },
    });

    // Should show dividend amount field, not shares and price
    expect(screen.getByLabelText("Dividend Amount")).toBeInTheDocument();
    expect(screen.queryByLabelText("Shares")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();

    // Enter dividend amount
    fireEvent.change(screen.getByLabelText("Dividend Amount"), {
      target: { value: "100.00" },
    });

    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    // Verify buildDividendSplits was called with the correct amount
    expect(buildDividendSplitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cashAccountId: 2,
        incomeAccountId: 3,
        amountCents: 10000,
      })
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        investmentSplits: [
          expect.objectContaining({
            action: "dividend",
            sharesMicros: 0,
            priceMicros: 0,
          }),
        ],
      })
    );
  });

  it("shows total for dividend based on dividend amount", async () => {
    setup();
    await enterInvestmentMode();

    // Change action to dividend
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "dividend" },
    });

    // Enter dividend amount
    fireEvent.change(screen.getByLabelText("Dividend Amount"), {
      target: { value: "250.50" },
    });

    // Check that total displays the dividend amount
    const total = screen.getByTestId("investment-total");
    expect(total.textContent).toBe("$250.50");
  });

  it("allows entering a capital gain with just an amount", async () => {
    const buildCapGainSplitsSpy = vi.spyOn(accounting, "buildCapGainSplits").mockReturnValue([
      { accountId: 2, amount: 15000 },
      { accountId: 3, amount: -15000 },
    ]);
    const { onSubmit } = setup();
    await enterInvestmentMode();

    // Change action to capital gain
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "capGain" },
    });

    // Should show capital gain amount field, not shares and price
    expect(screen.getByLabelText("Capital Gain Amount")).toBeInTheDocument();
    expect(screen.queryByLabelText("Shares")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();

    // Enter capital gain amount
    fireEvent.change(screen.getByLabelText("Capital Gain Amount"), {
      target: { value: "150.00" },
    });

    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    // Verify buildCapGainSplits was called with the correct amount
    expect(buildCapGainSplitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cashAccountId: 2,
        incomeAccountId: 3,
        amountCents: 15000,
      })
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        investmentSplits: [
          expect.objectContaining({
            action: "capGain",
            sharesMicros: 0,
            priceMicros: 0,
          }),
        ],
      })
    );
  });

  it("shows total for capital gain based on capital gain amount", async () => {
    setup();
    await enterInvestmentMode();

    // Change action to capital gain
    fireEvent.change(screen.getByLabelText("Action"), {
      target: { value: "capGain" },
    });

    // Enter capital gain amount
    fireEvent.change(screen.getByLabelText("Capital Gain Amount"), {
      target: { value: "325.75" },
    });

    // Check that total displays the capital gain amount
    const total = screen.getByTestId("investment-total");
    expect(total.textContent).toBe("$325.75");
  });

  it("prefills the price when a fixed-price security is selected", async () => {
    // A money market fund trades at its fixed NAV, so typing the price every
    // time is busywork the form already knows the answer to.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 11,
          name: "Vanguard Federal Money Market",
          symbol: "VMFXX",
          securityType: "mutual_fund",
          fixedPriceMicros: 1_000_000,
        },
      ],
    });
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Investment" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/securities",
        expect.objectContaining({ method: "GET" })
      );
    });
    fireEvent.focus(screen.getByLabelText("Security"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("VMFXX"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("VMFXX"))!
    );

    expect(screen.getByLabelText("Price (fixed)")).toHaveValue("1.00");
  });

  it("keeps a saved transaction's own price when editing a fixed-price security", async () => {
    // The fixed price is today's rule, not a rewrite of what was recorded at
    // the time. Loading a transaction for edit must leave its price alone.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 11,
          name: "Vanguard Federal Money Market",
          symbol: "VMFXX",
          securityType: "mutual_fund",
          fixedPriceMicros: 1_000_000,
        },
      ],
    });

    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={null}
        onSubmit={vi.fn()}
        editingTransaction={{
          id: 124,
          bookId: 1,
          date: "2024-05-01",
          description: "Buy VMFXX",
          checkNumber: null,
          notes: null,
          payeeId: null,
          isReconciled: false,
          isFloating: false,
          recurringRuleId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          payee: null,
          splits: [
            {
              id: 1,
              bookId: 1,
              transactionId: 124,
              accountId: 1,
              amount: 9900,
              account: mockAccounts[0],
            },
            {
              id: 2,
              bookId: 1,
              transactionId: 124,
              accountId: 2,
              amount: -9900,
              account: mockAccounts[1],
            },
          ],
          investmentSplits: [
            {
              id: 1,
              bookId: 1,
              transactionId: 124,
              securityId: 11,
              accountId: 1,
              lotId: null,
              action: "buy" as const,
              sharesMicros: 10_000_000,
              priceMicros: 990_000,
              feesCents: 0,
              splitNumerator: null,
              splitDenominator: null,
            },
          ],
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Price")).toHaveValue("0.99");
    });
  });

  it("labels the price field as fixed for a fixed-price security", async () => {
    // Prefilling silently would look like the form guessed. The label says why
    // the value is already there — and that overtyping it is unusual.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 11,
          name: "Vanguard Federal Money Market",
          symbol: "VMFXX",
          securityType: "mutual_fund",
          fixedPriceMicros: 1_000_000,
        },
        { id: 10, name: "Acme Corp", symbol: "ACME", securityType: "stock" },
      ],
    });
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Investment" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/securities",
        expect.objectContaining({ method: "GET" })
      );
    });

    // A normal security keeps the plain label.
    fireEvent.focus(screen.getByLabelText("Security"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("ACME"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("ACME"))!
    );
    expect(screen.getByLabelText("Price")).toBeInTheDocument();

    fireEvent.focus(screen.getByLabelText("Security"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("VMFXX"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("VMFXX"))!
    );

    expect(screen.getByLabelText("Price (fixed)")).toBeInTheDocument();
  });

  const twoSecurities = [
    {
      id: 11,
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fixedPriceMicros: 1_000_000,
    },
    { id: 10, name: "Acme Corp", symbol: "ACME", securityType: "stock" },
  ];

  const pickSecurity = async (symbol: string) => {
    fireEvent.focus(screen.getByLabelText("Security"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes(symbol))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes(symbol))!
    );
  };

  const enterInvestmentModeWith = async (securities: unknown[]) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => securities });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Investment" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/securities",
        expect.objectContaining({ method: "GET" })
      );
    });
  };

  it("clears the auto-filled price when switching to an ordinary security", async () => {
    // The prefilled NAV belongs to the fund, not to the next security picked;
    // leaving it behind would record the wrong cash amount.
    await enterInvestmentModeWith(twoSecurities);

    await pickSecurity("VMFXX");
    expect(screen.getByLabelText("Price (fixed)")).toHaveValue("1.00");

    await pickSecurity("ACME");

    expect(screen.getByLabelText("Price")).toHaveValue("");
  });

  it("keeps a price the user typed when switching securities", async () => {
    // Only the value the form filled in is disposable. A price the user typed
    // survives a security change here, as it always has.
    await enterInvestmentModeWith(twoSecurities);

    await pickSecurity("VMFXX");
    fireEvent.change(screen.getByLabelText("Price (fixed)"), {
      target: { value: "2.50" },
    });

    await pickSecurity("ACME");

    expect(screen.getByLabelText("Price")).toHaveValue("2.50");
  });
});
