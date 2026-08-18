// Regression test for PR #115: NewExpenseSubflow was extracted out of
// TransactionForm with its draft name/parent/isCreating state owned locally
// in the child. Both call sites in TransactionForm sit under mode
// conditionals (the full-layout site is inside a `mode === "simple" ? ... :`
// ternary — see TransactionForm.tsx around the "+ New Expense Account"
// button), so switching mode unmounts NewExpenseSubflow even though
// `showNewExpense` (owned by the parent) survives. A locally-owned
// `isCreatingExpense` double-submit guard is destroyed along with it,
// letting a second POST fire and creating a duplicate expense account. The
// fix lifts the three variables back into TransactionForm and passes them
// down as controlled props, so both render sites share one state that
// survives the mode switch.
//
// This exercises the full (desktop) layout via `fullLayout`, not the compact
// layout: the compact layout renders NewExpenseSubflow once, outside any
// `mode === X &&` block, so it was never affected by this regression.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("NewExpenseSubflow survives a mode switch (full layout)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.startsWith("/api/b/1/accounts")) {
        // Never resolves within a test unless the test itself resolves it —
        // simulates a POST that's still in flight when the user switches away.
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openPanelAndTypeName = async (name: string) => {
    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={3}
        fullLayout
        onSubmit={vi.fn()}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "+ New Expense Account" }));
    const nameInput = screen.getByLabelText("New Expense Name");
    fireEvent.change(nameInput, { target: { value: name } });
    expect(nameInput).toHaveValue(name);
  };

  const switchModeAwayAndBack = () => {
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    fireEvent.click(screen.getByRole("button", { name: "Simple" }));
  };

  it("keeps the typed expense name after switching modes and back", async () => {
    await openPanelAndTypeName("Coffee");

    switchModeAwayAndBack();

    // The panel re-mounts (NewExpenseSubflow was unmounted by the mode
    // switch), but the draft name is parent state now, so it survives.
    expect(screen.getByLabelText("New Expense Name")).toHaveValue("Coffee");
  });

  it("keeps the Create button disabled across a mode switch while the create request is in flight", async () => {
    await openPanelAndTypeName("Coffee");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // The guard flips synchronously with the click; the POST itself never
    // resolves in this test (see the fetch mock above).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    });

    switchModeAwayAndBack();

    // If the guard were still local child state, this fresh instance would
    // read isCreating === false and re-enable the button, letting a second
    // click fire a duplicate POST.
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
  });
});
