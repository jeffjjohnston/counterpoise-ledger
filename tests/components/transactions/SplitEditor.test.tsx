import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitEditor } from "@/components/transactions/SplitEditor";
import type { AccountWithBalance, SplitInput } from "@/types";

const mockAccounts: AccountWithBalance[] = [
  {
    id: 1,
    bookId: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isFavorite: false,
    isInvestmentCash: false,
    icon: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 10000,
    hasTransactions: true,
  },
  {
    id: 2,
    bookId: 1,
    name: "Groceries",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isFavorite: false,
    isInvestmentCash: false,
    icon: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 5000,
    hasTransactions: true,
  },
  {
    id: 3,
    bookId: 1,
    name: "Credit Card",
    type: "liability",
    subtype: "credit_card",
    parentId: null,
    isActive: true,
    isFavorite: false,
    isInvestmentCash: false,
    icon: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: -2000,
    hasTransactions: true,
  },
];

describe("SplitEditor", () => {
  it("renders split rows", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    // Should have 2 account input rows (textbox role from AccountAutocomplete)
    // Plus 2 debit inputs and 2 credit inputs, so we filter by specific display value
    expect(screen.getByDisplayValue("Checking")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Groceries")).toBeInTheDocument();
  });

  it("displays Balanced when splits sum to zero", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    expect(screen.getByText("Balanced")).toBeInTheDocument();
  });

  it("displays Off by amount when unbalanced", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -3000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    expect(screen.getByText("Off by $20.00")).toBeInTheDocument();
  });

  it("shows Add Line button", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    expect(screen.getByText("+ Add Line")).toBeInTheDocument();
  });

  it("calls onChange with new split when Add Line is clicked", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    fireEvent.click(screen.getByText("+ Add Line"));

    expect(onChange).toHaveBeenCalled();
    const newSplits = onChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(3);
  });

  it("new split auto-balances the transaction", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -3000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    fireEvent.click(screen.getByText("+ Add Line"));

    const newSplits = onChange.mock.calls[0][0];
    // Should add a split with -2000 to balance the transaction
    expect(newSplits[2].amount).toBe(-2000);
  });

  it("does not show remove button when only 2 splits", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    // X buttons should not be present
    const removeButtons = document.querySelectorAll('button svg');
    expect(removeButtons).toHaveLength(0);
  });

  it("shows remove buttons when more than 2 splits", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -3000 },
      { accountId: 3, amount: -2000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    // Should have 3 X buttons (one for each row)
    const removeButtons = document.querySelectorAll('button svg');
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it("displays debits and credits totals", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    expect(screen.getByText("Debits: $50.00")).toBeInTheDocument();
    expect(screen.getByText("Credits: $50.00")).toBeInTheDocument();
  });

  it("allows decimal input for journal entry amounts", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 0 },
      { accountId: 2, amount: 0 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    const [debitInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(debitInput, { target: { value: "12.34" } });

    const latestSplits = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(latestSplits[0].amount).toBe(1234);
    expect(debitInput).toHaveValue("12.34");
  });

  it("accepts formatted currency input with commas and symbols", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 0 },
      { accountId: 2, amount: 0 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    const [debitInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(debitInput, { target: { value: "$1,234.56" } });

    const latestSplits = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(latestSplits[0].amount).toBe(123456);
    expect(debitInput).toHaveValue("1234.56");
  });

  it("treats negative expression results as invalid for debit and credit columns", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 0 },
      { accountId: 2, amount: 0 },
    ];
    const onChange = vi.fn();
    const onPendingChange = vi.fn();

    render(
      <SplitEditor
        splits={splits}
        onChange={onChange}
        accounts={mockAccounts}
        onPendingChange={onPendingChange}
      />
    );

    const [debitInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(debitInput, { target: { value: "10-15" } });

    const latestSplits = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(latestSplits[0].amount).toBe(0);
    expect(screen.getByText("Resolve amounts")).toBeInTheDocument();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
  });

  it("does not silently truncate malformed numeric input on blur", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 0 },
      { accountId: 2, amount: 0 },
    ];
    const onChange = vi.fn();
    const onPendingChange = vi.fn();

    render(
      <SplitEditor
        splits={splits}
        onChange={onChange}
        accounts={mockAccounts}
        onPendingChange={onPendingChange}
      />
    );

    const [debitInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(debitInput, { target: { value: "1..2" } });
    fireEvent.blur(debitInput);

    const latestSplits = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(latestSplits[0].amount).toBe(0);
    expect(screen.getByText("Resolve amounts")).toBeInTheDocument();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
  });

  it("does not zero out debit when empty credit field is blurred", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 0 },
      { accountId: 2, amount: 0 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    // Type a debit value in the first row
    const debitInputs = screen.getAllByPlaceholderText("0.00");
    const debitInput = debitInputs[0]; // first row debit
    const creditInput = debitInputs[1]; // first row credit
    fireEvent.change(debitInput, { target: { value: "2.62" } });

    // Now focus and blur the credit field of the same row (simulates clicking into it then away)
    fireEvent.focus(creditInput);
    fireEvent.blur(creditInput);

    // The debit amount should still be intact
    const latestCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(latestCall[0].amount).toBe(262);
  });

  it("displays inactive accounts when they are selected in splits", () => {
    const accountsWithInactive: AccountWithBalance[] = [
      ...mockAccounts,
      {
        id: 4,
        bookId: 1,
        name: "Old Savings",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isActive: false,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: 0,
        hasTransactions: false,
      },
    ];

    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 4, amount: -5000 }, // Using inactive account
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={accountsWithInactive} />);

    // Inactive account should be displayed with "(inactive)" label
    expect(screen.getByDisplayValue("Old Savings (inactive)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Checking")).toBeInTheDocument();
  });

  it("selects the full amount on focus so it can be replaced by typing", () => {
    const splits: SplitInput[] = [
      { accountId: 1, amount: 5000 },
      { accountId: 2, amount: -5000 },
    ];
    const onChange = vi.fn();

    render(<SplitEditor splits={splits} onChange={onChange} accounts={mockAccounts} />);

    const [debitInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.focus(debitInput);

    expect(debitInput.selectionStart).toBe(0);
    expect(debitInput.selectionEnd).toBe(debitInput.value.length);
    expect(debitInput.value).not.toBe("");
  });
});
