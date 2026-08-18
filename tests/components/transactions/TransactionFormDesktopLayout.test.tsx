// TransactionFormInvestmentPayload.test.tsx's tests all use default props, so
// they only ever exercise InvestmentEntrySection's compact branch (see the
// "Coverage gap" note at the top of that file). This file exercises the
// desktop branch instead, reached via `fullLayout` (compact = !fullLayout &&
// !editingTransaction). It copies the harness pieces it needs — mockAccounts,
// renderWithToast, the next/navigation mock, the securities fetchMock —
// rather than importing them, matching how the payload gate was written.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
];

describe("TransactionForm desktop investment layout", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the desktop investment field set, not the compact one", () => {
    renderWithToast(
      <TransactionForm
        accounts={mockAccounts}
        selectedAccountId={null}
        isInvestmentAccountSelected
        fullLayout
        onSubmit={vi.fn()}
      />
    );

    // Desktop-only label; compact renders "Inv. Account" instead.
    expect(screen.getByLabelText("Investment Account")).toBeInTheDocument();
    expect(screen.queryByLabelText("Inv. Account")).not.toBeInTheDocument();

    // Desktop-only Action option labels; compact renders "Cap Gain" / "Split".
    const optionLabels = Array.from(
      (screen.getByLabelText("Action") as HTMLSelectElement).options
    ).map((option) => option.text);
    expect(optionLabels).toContain("Capital Gain");
    expect(optionLabels).toContain("Stock Split");
    expect(optionLabels).not.toContain("Cap Gain");
    expect(optionLabels).not.toContain("Split");
  });
});
