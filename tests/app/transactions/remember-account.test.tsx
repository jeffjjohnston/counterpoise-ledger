import { render, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ */
/* localStorage stub (works reliably in all Vitest pool modes)         */
/* ------------------------------------------------------------------ */

const localStorageStore: Record<string, string> = {};
const localStorageMock: Storage = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageStore[key];
  },
  clear: () => {
    for (const key of Object.keys(localStorageStore)) {
      delete localStorageStore[key];
    }
  },
  get length() {
    return Object.keys(localStorageStore).length;
  },
  key: (index: number) => Object.keys(localStorageStore)[index] ?? null,
};

vi.stubGlobal("localStorage", localStorageMock);

/* ------------------------------------------------------------------ */
/* Mutable state that individual tests configure before rendering     */
/* ------------------------------------------------------------------ */

let searchParamsValue = new URLSearchParams();
const replaceMock = vi.fn();
const pushMock = vi.fn();

/* ------------------------------------------------------------------ */
/* Module-level mocks (hoisted by Vitest)                             */
/* ------------------------------------------------------------------ */

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsValue,
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("@/components/accounts/AccountList", () => ({
  AccountList: () => <div data-testid="account-list" />,
  DEFAULT_EXPANDED_TYPES: new Set(["asset", "liability"]),
  DEFAULT_EXPANDED_SUBTYPES: new Set([
    "bank",
    "investment",
    "credit_card",
    "loan",
    "cash",
    "other",
  ]),
}));

vi.mock("@/components/KeyboardShortcutProvider", () => ({
  useKeyboardShortcuts: () => ({
    isOverlayOpen: false,
    setOverlayOpen: () => {},
    registerShortcuts: () => () => {},
    allShortcuts: [],
    pendingPrefix: null,
  }),
}));

vi.mock("@/components/transactions/TransactionList", () => ({
  TransactionList: () => <div data-testid="transaction-list" />,
}));

vi.mock("@/components/transactions/TransactionForm", () => ({
  TransactionForm: () => <div data-testid="transaction-form" />,
}));

vi.mock("@/components/transactions/InvestmentPositionsSection", () => ({
  InvestmentPositionsSection: () => (
    <div data-testid="investment-positions" />
  ),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="modal">{children}</div>
  ),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

/* ------------------------------------------------------------------ */
/* Test account fixtures                                               */
/* ------------------------------------------------------------------ */

function makeAccount(overrides: Partial<{
  id: number;
  bookId: number;
  name: string;
  type: string;
  subtype: string;
  parentId: number | null;
  isFavorite: boolean;
  isActive: boolean;
  isInvestmentCash: boolean;
  icon: string | null;
  balance: number;
}>) {
  return {
    id: 1,
    bookId: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isFavorite: false,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    balance: 10000,
    hasTransactions: true,
    children: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const checkingAccount = makeAccount({ id: 1, name: "Checking" });
const savingsAccount = makeAccount({
  id: 2,
  name: "Savings",
  isFavorite: true,
});
const creditCardAccount = makeAccount({
  id: 3,
  name: "Amex",
  type: "liability",
  subtype: "credit_card",
  isFavorite: true,
});
const inactiveAccount = makeAccount({
  id: 4,
  name: "Old Checking",
  isActive: false,
});
const investmentCashAccount = makeAccount({
  id: 5,
  name: "Brokerage Cash",
  subtype: "cash",
  parentId: 6,
  isInvestmentCash: true,
  isFavorite: false,
});

const allAccounts = [
  checkingAccount,
  savingsAccount,
  creditCardAccount,
  inactiveAccount,
  investmentCashAccount,
];

/* ------------------------------------------------------------------ */
/* Fetch mock builder                                                  */
/* ------------------------------------------------------------------ */

function buildFetchMock(accounts = allAccounts) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/b/1/accounts")) {
      return { ok: true, json: async () => accounts } as Response;
    }
    if (url.startsWith("/api/b/1/transactions")) {
      return {
        ok: true,
        json: async () => ({
          transactions: [],
          totalCount: 0,
          startingBalance: 0,
        }),
      } as Response;
    }
    if (url.startsWith("/api/b/1/payees")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/investments/account-values")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/investments/positions")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/recurring/projected")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
      return {
        ok: true,
        json: async () => ({ totalCount: 0, accounts: [] }),
      } as Response;
    }
    if (url.startsWith("/api/b/1/sync/pending-transactions")) {
      return { ok: true, json: async () => [] } as Response;
    }
    throw new Error(`Unexpected fetch url: ${url}`);
  });
}

/* ------------------------------------------------------------------ */
/* Test suite                                                          */
/* ------------------------------------------------------------------ */

describe("Transactions page — remember selected account", () => {
  beforeEach(() => {
    vi.resetModules();
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParamsValue = new URLSearchParams();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ----------------------------------------------------------------
   * 1. localStorage persistence: URL has accountId → stores it
   * ---------------------------------------------------------------- */
  it("stores the selected accountId in localStorage when URL has accountId", async () => {
    searchParamsValue = new URLSearchParams("accountId=2");
    vi.stubGlobal("fetch", buildFetchMock());

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(localStorage.getItem("lastSelectedAccountId:1")).toBe("2");
    });

    // No redirect should have been triggered
    expect(replaceMock).not.toHaveBeenCalled();
  });

  /* ----------------------------------------------------------------
   * 2. Auto-select from localStorage: no accountId in URL, stored value
   * ---------------------------------------------------------------- */
  it("redirects to stored account from localStorage when no accountId in URL", async () => {
    searchParamsValue = new URLSearchParams(); // no accountId
    localStorage.setItem("lastSelectedAccountId:1", "2"); // Savings

    vi.stubGlobal("fetch", buildFetchMock());

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/b/1/transactions?accountId=2",
        { scroll: false }
      );
    });
  });

  /* ----------------------------------------------------------------
   * 3. Favorite fallback: no stored account → redirects to first
   *    favorite (alphabetical)
   * ---------------------------------------------------------------- */
  it("redirects to first favorite account (alphabetical) when no stored account", async () => {
    searchParamsValue = new URLSearchParams(); // no accountId
    // No localStorage entry

    vi.stubGlobal("fetch", buildFetchMock());

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    // Favorites: Amex (id=3) and Savings (id=2). Alphabetically "Amex" < "Savings".
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/b/1/transactions?accountId=3",
        { scroll: false }
      );
    });
  });

  /* ----------------------------------------------------------------
   * 4. Inactive account skip: stored account is inactive → fall back
   *    to favorites
   * ---------------------------------------------------------------- */
  it("skips inactive stored account and falls back to favorites", async () => {
    searchParamsValue = new URLSearchParams(); // no accountId
    localStorage.setItem("lastSelectedAccountId:1", "4"); // Old Checking (inactive)

    vi.stubGlobal("fetch", buildFetchMock());

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    // Should skip account 4 (inactive) and fall back to first favorite
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/b/1/transactions?accountId=3",
        { scroll: false }
      );
    });
  });

  /* ----------------------------------------------------------------
   * 5. No redirect when URL has accountId
   * ---------------------------------------------------------------- */
  it("does not redirect when accountId is already in the URL", async () => {
    searchParamsValue = new URLSearchParams("accountId=1");
    vi.stubGlobal("fetch", buildFetchMock());

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    // Wait for data load to complete
    await waitFor(() => {
      const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      const txCalls = fetchCalls.filter((call: unknown[]) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        return url.startsWith("/api/b/1/transactions");
      });
      expect(txCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Ensure no redirect was triggered
    expect(replaceMock).not.toHaveBeenCalled();
  });

  /* ----------------------------------------------------------------
   * 6. No redirect when no stored account AND no favorites
   * ---------------------------------------------------------------- */
  it("does not redirect when there is no stored account and no favorites", async () => {
    searchParamsValue = new URLSearchParams(); // no accountId
    // No localStorage entry

    // Use only non-favorite accounts
    const noFavoriteAccounts = [
      makeAccount({ id: 10, name: "Plain Checking", isFavorite: false }),
      makeAccount({ id: 11, name: "Plain Savings", isFavorite: false }),
    ];
    vi.stubGlobal("fetch", buildFetchMock(noFavoriteAccounts));

    const { default: TransactionsPage } = await import(
      "@/app/b/[bookId]/transactions/page"
    );

    render(<TransactionsPage />);

    // Wait for data load to complete
    await waitFor(() => {
      const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      const txCalls = fetchCalls.filter((call: unknown[]) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        return url.startsWith("/api/b/1/transactions");
      });
      expect(txCalls.length).toBeGreaterThanOrEqual(1);
    });

    // No redirect should have happened
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
