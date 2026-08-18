import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import type { AccountWithBalance } from "@/types";

describe("AccountAutocomplete", () => {
  const mockAccounts: AccountWithBalance[] = [
    {
      id: 1,
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
      id: 2,
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
      id: 3,
      bookId: 1,
      name: "Electric",
      type: "expense",
      subtype: null,
      parentId: 2,
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
      id: 4,
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
  ];

  it("renders with placeholder when no value selected", () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={null}
        onChange={onChange}
        placeholder="Select an account"
      />
    );

    expect(screen.getByPlaceholderText("Select an account")).toBeInTheDocument();
  });

  it("shows selected account name", () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={1}
        onChange={onChange}
      />
    );

    expect(screen.getByDisplayValue("Groceries")).toBeInTheDocument();
  });

  it("allows clearing input text for a selected account before typing a new search", () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={1}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "util" } });
    expect(input).toHaveValue("util");
  });

  it("shows hierarchy for child accounts", () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={3}
        onChange={onChange}
        showHierarchy={true}
      />
    );

    expect(screen.getByDisplayValue("Utilities : Electric")).toBeInTheDocument();
  });

  it("filters accounts by search term", async () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={null}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "util" } });

    await waitFor(() => {
      expect(screen.getByText("Utilities")).toBeInTheDocument();
    });

    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
  });

  it("filters by account type when specified", () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={null}
        onChange={onChange}
        filterType="expense"
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByText("Checking")).not.toBeInTheDocument();
  });

  it("calls onChange when account is selected", async () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={null}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText("Groceries")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Groceries"));

    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("clears selection when clear button is clicked", async () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={1}
        onChange={onChange}
        allowClear={true}
      />
    );

    const clearButton = screen.getByRole("button");
    fireEvent.click(clearButton);

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keyboard navigation works", async () => {
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={null}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    // Arrow down to select first item
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
  });

  it("shows a category icon for an iconed category in the dropdown", async () => {
    const iconedAccounts: AccountWithBalance[] = [
      { ...mockAccounts[0], icon: "🚗" },
      ...mockAccounts.slice(1),
    ];
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={iconedAccounts}
        value={null}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText("🚗")).toBeInTheDocument();
    });
  });

  it("shows no glyph for an asset account in the same dropdown", async () => {
    // Checking gets its own icon here, not just a neighbor's icon to not
    // leak. That way the assertion fails if the income/expense type filter
    // in buildCategoryLabelMap is ever deleted (Checking would then resolve
    // its own icon) and also if a renderer ever passes `account.icon`
    // straight through instead of the resolved, type-filtered value.
    const iconedAccounts: AccountWithBalance[] = [
      { ...mockAccounts[0], icon: "🚗" },
      mockAccounts[1],
      mockAccounts[2],
      { ...mockAccounts[3], icon: "🏦" },
    ];
    const onChange = vi.fn();
    render(
      <AccountAutocomplete
        accounts={iconedAccounts}
        value={null}
        onChange={onChange}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText("Checking")).toBeInTheDocument();
    });

    const checkingRow = screen.getByText("Checking").closest("button");
    expect(checkingRow).not.toBeNull();
    expect(within(checkingRow!).queryByText("🏦")).not.toBeInTheDocument();
  });

  it("applies a warning ring to the input only when warning is set", () => {
    const { rerender } = render(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={4}
        onChange={vi.fn()}
        label="From Account"
      />
    );
    expect(screen.getByLabelText("From Account")).not.toHaveClass("ring-fg-warning");

    rerender(
      <AccountAutocomplete
        accounts={mockAccounts}
        value={4}
        onChange={vi.fn()}
        label="From Account"
        warning
      />
    );
    expect(screen.getByLabelText("From Account")).toHaveClass("ring-fg-warning");
  });
});
