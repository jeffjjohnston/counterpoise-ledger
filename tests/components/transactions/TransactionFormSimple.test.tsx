import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance } from "@/types";

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

// ToastProvider's own stack container also carries role="status" (for
// screen-reader announcements), so a bare getByRole("status") is now
// ambiguous whenever a test renders inside renderWithToast. This picks out
// the account-mismatch warning banner specifically.
const getWarningStatus = () =>
  screen.getAllByRole("status").find((el) => /won't appear in/i.test(el.textContent ?? ""));

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
  {
    id: 5,
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
    balance: 0,
    hasTransactions: true,
  },
];

describe("TransactionForm simple mode", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 1, name: "Blue Bottle" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("excludes investment accounts while keeping investment cash accounts", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Open the From Account dropdown
    const fromAccountInput = screen.getByLabelText("From Account");
    fireEvent.focus(fromAccountInput);

    await waitFor(() => {
      const buttons = screen.queryAllByRole("button");
      const hasBrokerageCash = buttons.some(btn => btn.textContent?.includes("Brokerage Cash"));
      expect(hasBrokerageCash).toBe(true);
    });

    // Check that "Brokerage" (investment account) is not in the dropdown
    const buttons = screen.getAllByRole("button");
    const brokerageButton = buttons.find(btn =>
      btn.textContent === "Brokerage" && !btn.textContent.includes("Cash")
    );
    expect(brokerageButton).toBeUndefined();

    // Check that "Brokerage Cash" appears in the dropdown
    const brokerageCashButtons = buttons.filter(btn => btn.textContent?.includes("Brokerage Cash"));
    expect(brokerageCashButtons.length).toBeGreaterThan(0);
  });

  it("remaps selected investment accounts to investment cash in simple mode", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={1} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The From Account input should show "Brokerage Cash" (id: 2) instead of "Brokerage" (id: 1)
    const fromAccountInput = screen.getByLabelText("From Account") as HTMLInputElement;
    expect(fromAccountInput.value).toBe("Brokerage Cash");
  });

  it("updates From Account default when selectedAccountId changes", async () => {
    const { rerender } = renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={1} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const fromAccountInput = screen.getByLabelText("From Account") as HTMLInputElement;
    expect(fromAccountInput.value).toBe("Brokerage Cash");

    rerender(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
      </ToastProvider>
    );

    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
  });

  it("shows check number input when a bank account is involved", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Expand details to see check number
    fireEvent.click(screen.getByLabelText("Show details"));
    expect(screen.getByLabelText("Check #")).toBeInTheDocument();
  });

  it("renders compact layout with all fields present for new simple entry", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Row 1 fields are always visible
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    expect(screen.getByLabelText("From Account")).toBeInTheDocument();
    expect(screen.getByLabelText("To Account")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.getByLabelText("Swap From and To accounts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Transaction" })).toBeInTheDocument();

    // Details hidden by default, expand to check they exist
    fireEvent.click(screen.getByLabelText("Show details"));
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Check #")).toBeInTheDocument();

    // All fields in a single grid row (row 1)
    const dateInput = screen.getByLabelText("Date");
    const amountInput = screen.getByLabelText("Amount");
    const row1 = dateInput.closest("div.grid");
    expect(row1).toBeTruthy();
    expect(amountInput.closest("div.grid")).toBe(row1);
  });

  it("submits a check number for bank-account transactions", async () => {
    const onSubmit = vi.fn();
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const toAccountInput = screen.getByLabelText("To Account");
    fireEvent.focus(toAccountInput);

    await waitFor(() => {
      const buttons = screen.queryAllByRole("button");
      const groceriesButton = buttons.find((btn) =>
        btn.textContent?.includes("Groceries")
      );
      expect(groceriesButton).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole("button");
    const groceriesButton = buttons.find((btn) =>
      btn.textContent?.includes("Groceries")
    );
    fireEvent.click(groceriesButton!);

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "25.00" },
    });
    // Expand details to access check number
    fireEvent.click(screen.getByLabelText("Show details"));
    fireEvent.change(screen.getByLabelText("Check #"), {
      target: { value: "1234" },
    });

    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ checkNumber: "1234" })
    );
  });

  it("rejects invalid amount expressions in simple mode", async () => {
    const onSubmit = vi.fn();
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const toAccountInput = screen.getByLabelText("To Account");
    fireEvent.focus(toAccountInput);

    await waitFor(() => {
      const buttons = screen.queryAllByRole("button");
      const groceriesButton = buttons.find((btn) =>
        btn.textContent?.includes("Groceries")
      );
      expect(groceriesButton).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole("button");
    const groceriesButton = buttons.find((btn) =>
      btn.textContent?.includes("Groceries")
    );
    fireEvent.click(groceriesButton!);

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "12+" },
    });

    const form = screen
      .getByRole("button", { name: "Add Transaction" })
      .closest("form");
    fireEvent.submit(form!);

    expect(await screen.findByText("Please enter a valid amount")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows payee suggestions when typing", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    const payeeInput = screen.getByLabelText("Payee");
    fireEvent.change(payeeInput, { target: { value: "Blue" } });

    await waitFor(() => {
      expect(screen.getByText("Blue Bottle")).toBeInTheDocument();
    });
  });

  it("locks transaction type when editing an existing transaction", async () => {
    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={null}
        onSubmit={vi.fn()}
        editingTransaction={{
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
              account: mockAccounts[3],
            },
            {
              id: 2,
              bookId: 1,
              transactionId: 99,
              accountId: 3,
              amount: -1250,
              account: mockAccounts[2],
            },
          ],
          investmentSplits: [],
        }}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const simpleButton = screen.getByRole("button", { name: "Simple" });
    const journalButton = screen.getByRole("button", { name: "Journal" });

    expect(simpleButton).toBeDisabled();
    expect(journalButton).toBeDisabled();

    fireEvent.click(journalButton);

    expect(screen.getByLabelText("From Account")).toBeInTheDocument();
    expect(screen.getByLabelText("To Account")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.queryByLabelText("Security")).not.toBeInTheDocument();
  });

  it("expands secondary row when expand button is clicked", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Secondary row is collapsed by default (no bank account)
    expect(screen.queryByLabelText("Description")).not.toBeInTheDocument();

    // Click expand button
    const expandButton = screen.getByLabelText("Show details");
    fireEvent.click(expandButton);

    // Secondary row should now be visible
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
  });

  it("auto-fills To with the selected account when From is changed away", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // From defaults to the selected account (Checking); To starts empty
    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
    expect(screen.getByLabelText("To Account")).toHaveValue("");

    // Change From to a different account (Groceries)
    fireEvent.focus(screen.getByLabelText("From Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))!
    );

    // To auto-updates to the selected account so it stays involved
    expect(screen.getByLabelText("From Account")).toHaveValue("Groceries");
    expect(screen.getByLabelText("To Account")).toHaveValue("Checking");
  });

  it("moves the selected account to From when To is changed away and From is no longer the selected account", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // First displace the selected account (Checking) onto the To side by changing From
    fireEvent.focus(screen.getByLabelText("From Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))!
    );
    expect(screen.getByLabelText("To Account")).toHaveValue("Checking");

    // Now change To away from the selected account → From should become Checking again
    fireEvent.focus(screen.getByLabelText("To Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Brokerage Cash"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Brokerage Cash"))!
    );

    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
  });

  it("leaves From untouched when To is changed while From already is the selected account", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // From is the selected account (Checking)
    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");

    // Change To to Groceries; the invariant already holds via From, so From stays put
    fireEvent.focus(screen.getByLabelText("To Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))!
    );

    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
  });

  it("warns when a new transaction involves neither side = the viewed account", async () => {
    // Payee auto-fill writes To directly, bypassing the From/To handlers.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.includes("/payees/1/last-account")) {
        return Promise.resolve({ ok: true, json: async () => ({ accountId: 4 }) });
      }
      if (url.startsWith("/api/b/1/payees")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 1, name: "Blue Bottle" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // From defaults to Checking; move it to Savings (handler puts Checking on To)
    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
    fireEvent.focus(screen.getByLabelText("From Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))!
    );
    expect(screen.getByLabelText("To Account")).toHaveValue("Checking");

    // Type a known payee → auto-fill overwrites To with Groceries → invariant broken
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Blue Bottle" } });

    await waitFor(() => {
      expect(getWarningStatus()).toHaveTextContent(/won't appear in/i);
    });
    expect(getWarningStatus()).toHaveTextContent("Checking");
  });

  it("does not warn when the viewed account is still the From account", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // From stays Checking (viewed); pick Groceries as To
    fireEvent.focus(screen.getByLabelText("To Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))!
    );

    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
    expect(screen.queryByText(/won't appear in/i)).toBeNull();
  });

  it("does not warn on the All Transactions view (no account selected)", async () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.focus(screen.getByLabelText("From Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))!
    );
    fireEvent.focus(screen.getByLabelText("To Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Groceries"))!
    );

    expect(screen.queryByText(/won't appear in/i)).toBeNull();
  });

  it("clears the warning once a dropdown points back at the viewed account", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.includes("/payees/1/last-account")) {
        return Promise.resolve({ ok: true, json: async () => ({ accountId: 4 }) });
      }
      if (url.startsWith("/api/b/1/payees")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 1, name: "Blue Bottle" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={vi.fn()} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.focus(screen.getByLabelText("From Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Savings"))!
    );
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Blue Bottle" } });
    await waitFor(() => {
      expect(getWarningStatus()).toBeInTheDocument();
    });

    // Point To back at the viewed account (Checking) → warning clears
    fireEvent.focus(screen.getByLabelText("To Account"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((b) => b.textContent?.includes("Checking"))
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getAllByRole("button").find((b) => b.textContent?.includes("Checking"))!
    );

    await waitFor(() => {
      expect(screen.queryByText(/won't appear in/i)).toBeNull();
    });
  });

  it("commits the simple entry from a labelled button, not a bare glyph", () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    const submit = screen.getByRole("button", { name: "Add Transaction" });
    expect(submit).toHaveAttribute("type", "submit");
    // Visible text, not a "+" explained only by an aria-label.
    expect(submit.textContent).toBe("Add");
    // size="md" rather than "sm": this is the primary action of the row.
    expect(submit).toHaveClass("px-4", "py-2");
  });

  it("keeps every quick-entry field named, but hides the labels on screen", () => {
    renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    // The register's column headers do the labelling now -- these used to be a
    // second row of labels forty pixels above an identical row of headers. The
    // names survive for assistive technology and for these selectors.
    for (const name of ["Date", "Payee", "From Account", "To Account", "Amount"]) {
      const field = screen.getByLabelText(name);
      expect(field).toBeInTheDocument();
      const label = document.querySelector(`label[for="${field.id}"]`);
      expect(label).toHaveClass("sr-only");
    }
  });

  it("lays the quick-entry row out on the register's own column widths", () => {
    const { container } = renderWithToast(
      <TransactionForm accounts={mockAccounts} selectedAccountId={null} onSubmit={vi.fn()} />
    );

    const grid = container.querySelector(".grid.items-end");
    // Date takes the 9rem an MM/DD/YYYY field needs and borrows most of the
    // overshoot back from Payee, so the Payee/Accounts boundary stays near the
    // register's. The rest match TRANSACTION_TABLE_COLUMN_WIDTHS one for one.
    // Kept in step by hand -- see the comment above the grid, which records why
    // the borrow is a fitted 3.5rem and cannot be exact.
    expect(grid).toHaveClass("grid-cols-[9rem_calc(32%_-_3.5rem)_24%_10rem_1fr]");
    // No gap: a grid gap would push each column right of its table column,
    // cumulatively. Spacing comes from cell padding, as it does in the table.
    expect(grid?.className).not.toMatch(/\bgap-\d/);
  });
});
