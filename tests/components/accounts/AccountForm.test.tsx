import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountForm } from "@/components/accounts/AccountForm";
import type { AccountWithBalance } from "@/types";

vi.mock("@/components/ui/AccountAutocomplete", () => ({
  AccountAutocomplete: ({ label }: { label?: string }) => <div data-testid="account-autocomplete">{label}</div>,
}));

// A parent with its own icon ("Automobile", 🚗) and two children: one with
// no icon of its own ("Gasoline", inherits 🚗) and one top-level category
// with no ancestor at all ("Entertainment", no icon anywhere in its chain).
const automobileAccount: AccountWithBalance = {
  id: 10, bookId: 1, name: "Automobile", type: "expense", subtype: null,
  parentId: null, isActive: true, isFavorite: false, isInvestmentCash: false,
  icon: "🚗", createdAt: new Date(), updatedAt: new Date(),
  balance: 0, hasTransactions: false,
};
const gasolineAccount: AccountWithBalance = {
  id: 11, bookId: 1, name: "Automobile:Gasoline", type: "expense", subtype: null,
  parentId: 10, isActive: true, isFavorite: false, isInvestmentCash: false,
  icon: null, createdAt: new Date(), updatedAt: new Date(),
  balance: 0, hasTransactions: false,
};
const entertainmentAccount: AccountWithBalance = {
  id: 12, bookId: 1, name: "Entertainment", type: "expense", subtype: null,
  parentId: null, isActive: true, isFavorite: false, isInvestmentCash: false,
  icon: null, createdAt: new Date(), updatedAt: new Date(),
  balance: 0, hasTransactions: false,
};
const iconAccounts = [automobileAccount, gasolineAccount, entertainmentAccount];

describe("AccountForm", () => {
  it("renders empty form for new account", () => {
    render(<AccountForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText("Account Name")).toHaveValue("");
    expect(screen.getByText("Create Account")).toBeInTheDocument();
  });

  it("pre-fills fields for existing account", () => {
    const account = {
      id: 1, bookId: 1, name: "Chase Checking", type: "asset" as const,
      subtype: "bank" as const, parentId: null, isActive: true, isInvestmentCash: false,
      icon: null,
      isFavorite: false, createdAt: new Date(), updatedAt: new Date(),
    };

    render(
      <AccountForm account={account} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByLabelText("Account Name")).toHaveValue("Chase Checking");
    expect(screen.getByText("Save Changes")).toBeInTheDocument();
  });

  it("shows active checkbox only for existing accounts", () => {
    render(<AccountForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("shows active checkbox when editing an account", () => {
    const account = {
      id: 1, bookId: 1, name: "Test", type: "asset" as const,
      subtype: null, parentId: null, isActive: true, isInvestmentCash: false,
      icon: null,
      isFavorite: false, createdAt: new Date(), updatedAt: new Date(),
    };

    render(
      <AccountForm account={account} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("calls onSubmit with form data", () => {
    const onSubmit = vi.fn();
    render(<AccountForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Account Name"), {
      target: { value: "New Account" },
    });

    fireEvent.click(screen.getByText("Create Account"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "New Account",
        type: "asset",
      })
    );
  });

  it("calls onCancel when cancel button clicked", () => {
    const onCancel = vi.fn();
    render(<AccountForm onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows subtype dropdown for asset type", () => {
    render(<AccountForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText("Subtype")).toBeInTheDocument();
  });

  it("hides subtype dropdown for income type", () => {
    render(<AccountForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Account Type"), {
      target: { value: "income" },
    });

    expect(screen.queryByLabelText("Subtype")).not.toBeInTheDocument();
  });

  it("shows the Icon field only for income and expense accounts", () => {
    render(<AccountForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Default type is asset — not a category, so no Icon field.
    expect(screen.queryByText("Icon")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Account Type"), {
      target: { value: "expense" },
    });

    expect(screen.getByText("Icon")).toBeInTheDocument();
  });

  it("shows the inherited icon message naming the ancestor (state a)", () => {
    render(
      <AccountForm
        account={gasolineAccount}
        accounts={iconAccounts}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText(/Inherits/)).toBeInTheDocument();
    expect(screen.getByText("Automobile")).toBeInTheDocument();
  });

  it("shows the no-icon message when no ancestor supplies one (state b)", () => {
    render(
      <AccountForm
        account={entertainmentAccount}
        accounts={iconAccounts}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(
      screen.getByText("No icon — the full category path is shown")
    ).toBeInTheDocument();
  });

  it("lets the user set an override icon, then revert to inherited (state c)", () => {
    render(
      <AccountForm
        account={gasolineAccount}
        accounts={iconAccounts}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose an icon" }));
    fireEvent.click(screen.getByText("🎯"));

    expect(screen.getByText(/Overrides 🚗/)).toBeInTheDocument();
    const useInherited = screen.getByRole("button", { name: "use inherited" });

    fireEvent.click(useInherited);

    expect(screen.getByText(/Inherits/)).toBeInTheDocument();
    expect(screen.getByText("Automobile")).toBeInTheDocument();
  });

  it("submits the chosen icon in the payload for a category account", () => {
    const onSubmit = vi.fn();
    render(
      <AccountForm
        account={gasolineAccount}
        accounts={iconAccounts}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose an icon" }));
    fireEvent.click(screen.getByText("🎯"));
    fireEvent.click(screen.getByText("Save Changes"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ icon: "🎯" })
    );
  });

  it("submits icon: undefined for a non-category account type, leaving the column untouched", () => {
    // Deliberately not `null`: the PUT route only writes the column when
    // `icon !== undefined`, so a non-category's icon (settable via the API
    // or a future MCP tool, per spec decision 5) survives an edit made
    // through this form instead of being silently cleared.
    const onSubmit = vi.fn();
    render(<AccountForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Account Name"), {
      target: { value: "New Asset" },
    });
    fireEvent.click(screen.getByText("Create Account"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ icon: undefined })
    );
  });
});
