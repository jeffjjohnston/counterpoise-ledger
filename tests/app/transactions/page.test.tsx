import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import TransactionsPage from "@/app/b/[bookId]/transactions/page";
import { PRICES_SAVED_EVENT } from "@/lib/events";
import { toDateString } from "@/lib/formatters";
import { TRANSACTION_CONFLICT_MESSAGE } from "@/lib/transaction-requests";
import type { TransactionWithSplits } from "@/types";

const pushMock = vi.fn();
const replaceMock = vi.fn();
let transactionListProps: Record<string, unknown> | null = null;
let transactionFormProps: Record<string, unknown> | null = null;
let searchParamsValue = new URLSearchParams("accountId=1");
const toast = { error: vi.fn(), success: vi.fn() };

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useSearchParams: () => searchParamsValue,
    useRouter: () => ({ push: pushMock, replace: replaceMock }),
    useParams: () => ({ bookId: "1" }),
  })
);

vi.mock("@/components/ui/ToastProvider", () => ({ useToast: () => toast }));

let bookRoleValue: { canWrite: boolean; isOwner: boolean; role: string } = {
  canWrite: true,
  isOwner: true,
  role: "owner",
};

vi.mock("@/components/BookRoleProvider", () => ({
  useBookRole: () => bookRoleValue,
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
  TransactionList: (props: Record<string, unknown>) => {
    transactionListProps = props;
    return <div data-testid="transaction-list" />;
  },
}));

vi.mock("@/components/transactions/TransactionForm", () => ({
  // The page mounts TransactionForm up to three times at once (the desktop
  // quick-add panel, the mobile create modal, and the edit modal) whenever
  // canWrite is true. Only the edit-modal instance passes editingTransaction,
  // so that is the one captured, under its own testid — a plain
  // "transaction-form" match would be ambiguous with the others mounted.
  TransactionForm: (props: Record<string, unknown>) => {
    if (props.editingTransaction) {
      transactionFormProps = props;
      return <div data-testid="edit-transaction-form" />;
    }
    return <div data-testid="transaction-form" />;
  },
}));

let balanceChartProps: Record<string, unknown> | null = null;

vi.mock("@/components/transactions/AccountBalanceChart", () => ({
  AccountBalanceChart: (props: Record<string, unknown>) => {
    balanceChartProps = props;
    return <div data-testid="account-balance-chart" />;
  },
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

const accountsPayload = [
  {
    id: 1,
    name: "Vanguard 401(k)",
    type: "asset",
    subtype: "investment",
    parentId: null,
    isFavorite: false,
    isInvestmentCash: false,
    icon: null,
    balance: 0,
  },
  {
    id: 2,
    name: "Vanguard Cash",
    type: "asset",
    subtype: "cash",
    parentId: 1,
    isFavorite: false,
    isInvestmentCash: true,
    icon: null,
    balance: 0,
  },
];

const transactionsPayload = {
  transactions: [],
  startingBalance: 0,
  totalCount: 0,
};

const positionsPayload: unknown[] = [];

/** The fetch responses every test needs, regardless of what it is testing. */
function standardFetchResponse(url: string): Response | undefined {
  if (url.startsWith("/api/b/1/accounts")) {
    return { ok: true, json: async () => accountsPayload } as Response;
  }
  if (url.startsWith("/api/b/1/investments/positions")) {
    return { ok: true, json: async () => positionsPayload } as Response;
  }
  if (url.startsWith("/api/b/1/investments/account-values")) {
    return { ok: true, json: async () => [] } as Response;
  }
  if (url === "/api/b/1/payees") {
    return { ok: true, json: async () => [] } as Response;
  }
  if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
    return { ok: true, json: async () => ({ totalCount: 0, accounts: [] }) } as Response;
  }
  if (url.startsWith("/api/b/1/sync/pending-transactions")) {
    return { ok: true, json: async () => [] } as Response;
  }
  return undefined;
}

function makeTransaction(
  overrides: Partial<TransactionWithSplits> = {}
): TransactionWithSplits {
  return {
    id: 7,
    bookId: 1,
    date: "2024-06-01",
    description: "Coffee",
    checkNumber: null,
    notes: null,
    payeeId: null,
    isReconciled: false,
    isFloating: false,
    recurringRuleId: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2024-06-01T00:00:00.000Z"),
    updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    payee: null,
    splits: [],
    investmentSplits: [],
    ...overrides,
  };
}

describe("TransactionsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    transactionListProps = null;
    transactionFormProps = null;
    balanceChartProps = null;
    toast.error.mockClear();
    toast.success.mockClear();
    searchParamsValue = new URLSearchParams("accountId=1");
    bookRoleValue = { canWrite: true, isOwner: true, role: "owner" };
  });

  it("fetches transactions once for investment accounts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => transactionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return {
          ok: true,
          json: async () => positionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url === "/api/b/1/payees") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
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

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      const transactionCalls = fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.startsWith("/api/b/1/transactions");
      });
      expect(transactionCalls).toHaveLength(1);
    });

    // Positions/market-value fetches depend on accounts being loaded first
    // (isInvestmentAccount is derived from account data), so wait for them
    await waitFor(() => {
      const positionsCalls = fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.startsWith("/api/b/1/investments/positions");
      });
      expect(positionsCalls).toHaveLength(1);
    });

    const accountCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.startsWith("/api/b/1/accounts");
    });
    const positionsCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.startsWith("/api/b/1/investments/positions");
    });
    const marketValueCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.startsWith("/api/b/1/investments/account-values");
    });

    expect(accountCalls).toHaveLength(1);
    expect(positionsCalls).toHaveLength(1);
    expect(marketValueCalls).toHaveLength(1);

    const today = toDateString(new Date());
    const accountUrl = new URL(
      typeof accountCalls[0][0] === "string"
        ? accountCalls[0][0]
        : accountCalls[0][0].toString(),
      "http://localhost"
    );
    const marketValueUrl = new URL(
      typeof marketValueCalls[0][0] === "string"
        ? marketValueCalls[0][0]
        : marketValueCalls[0][0].toString(),
      "http://localhost"
    );

    expect(accountUrl.searchParams.get("includeInactive")).toBe("true");
    expect(accountUrl.searchParams.get("asOfDate")).toBe(today);
    expect(marketValueUrl.searchParams.get("asOfDate")).toBe(today);
  });

  it("hides the mobile FAB from a viewer", async () => {
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
        return { ok: true, json: async () => ({ totalCount: 0, accounts: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/sync/pending-transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(
      screen.queryByRole("button", { name: "New transaction" })
    ).not.toBeInTheDocument();
  });

  it("refreshes data when the navbar pill reports saved prices", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
        return { ok: true, json: async () => ({ totalCount: 0, accounts: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/sync/pending-transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const transactionCalls = () =>
      fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.startsWith("/api/b/1/transactions");
      });

    render(<TransactionsPage />);
    await waitFor(() => expect(transactionCalls()).toHaveLength(1));

    fireEvent(window, new CustomEvent(PRICES_SAVED_EVENT));

    // The pill's saved event must trigger a data refresh so the positions
    // table picks up new market values
    await waitFor(() => expect(transactionCalls()).toHaveLength(2));
  });

  it("toggles favorite state for the selected account", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts?")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url === "/api/b/1/accounts/1" && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => ({ ...accountsPayload[0], isFavorite: true }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => transactionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return {
          ok: true,
          json: async () => positionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url === "/api/b/1/payees") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
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

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    const toggleButton = await screen.findByRole("button", {
      name: "Add to favorites",
    });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/accounts/1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ isFavorite: true }),
        })
      );
    });

    await screen.findByRole("button", {
      name: "Remove from favorites",
    });
  });

  it("navigates to account and highlights transaction from transaction list callback", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => transactionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return {
          ok: true,
          json: async () => positionsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url === "/api/b/1/payees") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
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

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(transactionListProps).not.toBeNull();
      expect(transactionListProps?.onNavigateToAccount).toBeTypeOf("function");
    });

    (transactionListProps?.onNavigateToAccount as (a: number, t: number) => void)(
      42,
      99
    );

    expect(pushMock).toHaveBeenCalledWith(
      "/b/1/transactions?accountId=42&highlight=99"
    );
  });

  it("navigates client-side even outside the test environment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
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

    vi.stubGlobal("fetch", fetchMock);

    // The page used to full-reload here, guarded by NODE_ENV !== "test" — so
    // the suite only ever saw the router.push fallback and could not tell the
    // two apart. Stub the environment the guard tested to pin the real path.
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(transactionListProps?.onNavigateToAccount).toBeTypeOf("function");
    });

    vi.stubEnv("NODE_ENV", "production");
    try {
      (
        transactionListProps?.onNavigateToAccount as (
          a: number,
          t: number
        ) => void
      )(42, 99);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(assignMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(
      "/b/1/transactions?accountId=42&highlight=99"
    );
  });

  it("re-fetches the target account and keeps the highlight after a client navigation", async () => {
    const targetAccounts = [
      ...accountsPayload,
      {
        id: 42,
        name: "Checking",
        type: "asset",
        subtype: "bank",
        parentId: null,
        isFavorite: false,
        isInvestmentCash: false,
        icon: null,
        balance: 0,
      },
    ];

    const highlightedTransaction = {
      id: 99,
      bookId: 1,
      date: "2026-02-05",
      description: "Rent",
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
      splits: [],
      investmentSplits: [],
    } as unknown as TransactionWithSplits;

    const transactionsUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => targetAccounts } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        transactionsUrls.push(url);
        // Only the target account holds the highlighted row, so a stale
        // fetch for the previous account cannot satisfy the assertions below.
        if (url.includes("accountId=42")) {
          return {
            ok: true,
            json: async () => ({
              transactions: [highlightedTransaction],
              startingBalance: 0,
              totalCount: 1,
            }),
          } as Response;
        }
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
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

    vi.stubGlobal("fetch", fetchMock);

    // A full page reload refreshes everything by construction; client
    // navigation does not. Drive the URL the way the App Router does so the
    // list has to re-fetch on its own.
    pushMock.mockImplementation((url: string) => {
      searchParamsValue = new URLSearchParams(url.split("?")[1] ?? "");
    });

    const { rerender } = render(<TransactionsPage />);

    await waitFor(() => {
      expect(transactionListProps?.onNavigateToAccount).toBeTypeOf("function");
    });

    await act(async () => {
      (
        transactionListProps?.onNavigateToAccount as (
          a: number,
          t: number
        ) => void
      )(42, 99);
    });

    await act(async () => {
      rerender(<TransactionsPage />);
    });

    await waitFor(() => {
      expect(
        transactionsUrls.some(
          (url) => url.includes("accountId=42") && url.includes("ensureId=99")
        )
      ).toBe(true);
      expect(transactionListProps?.highlightTransactionId).toBe(99);
      expect(
        (transactionListProps?.transactions as TransactionWithSplits[]).map(
          (tx) => tx.id
        )
      ).toContain(99);
    });
  });

  it("stops auto-retrying after a failed \"load more\" and lets the user retry manually", async () => {
    const buildTransaction = (id: number): TransactionWithSplits => ({
      id,
      bookId: 1,
      date: "2026-02-05",
      description: `Transaction ${id}`,
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
      splits: [],
      investmentSplits: [],
    });

    let observerCallback: IntersectionObserverCallback | null = null;
    const observeMock = vi.fn();
    const unobserveMock = vi.fn();

    const IntersectionObserverMock = vi.fn(function (
      this: {
        observe: (element: Element) => void;
        unobserve: (element: Element) => void;
      },
      callback: IntersectionObserverCallback
    ) {
      observerCallback = callback;
      this.observe = observeMock;
      this.unobserve = unobserveMock;
    });

    vi.stubGlobal(
      "IntersectionObserver",
      IntersectionObserverMock as unknown as typeof IntersectionObserver
    );

    const firstPage = Array.from({ length: 50 }, (_, index) =>
      buildTransaction(index + 1)
    );
    const secondPage = Array.from({ length: 25 }, (_, index) =>
      buildTransaction(index + 51)
    );

    let secondPageAttempts = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        if (url.includes("offset=50")) {
          secondPageAttempts += 1;
          if (secondPageAttempts === 1) {
            throw new Error("network down");
          }
          return {
            ok: true,
            json: async () => ({ transactions: secondPage, totalCount: 75 }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ transactions: firstPage, totalCount: 75 }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
        return { ok: true, json: async () => ({ totalCount: 0, accounts: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/sync/pending-transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(screen.getByText("Scroll for more")).toBeInTheDocument();
      expect(observeMock).toHaveBeenCalled();
      expect(observerCallback).not.toBeNull();
    });

    const observedElement = observeMock.mock.calls[0]?.[0] as Element | undefined;
    const fireIntersection = async () => {
      await act(async () => {
        observerCallback?.(
          [
            {
              isIntersecting: true,
              target: observedElement ?? document.createElement("div"),
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        );
      });
    };

    // First automatic trigger: the offset=50 fetch fails.
    await fireIntersection();

    await waitFor(() => {
      expect(secondPageAttempts).toBe(1);
      expect(
        screen.getByText("Could not load more transactions. Try again.")
      ).toBeInTheDocument();
    });

    // Simulate what a real browser does when the observer effect tears down
    // and recreates the observer (loadingMore/loadMoreFailed are both in its
    // dependency array): observer.observe() fires an immediate callback for
    // a sentinel that's still on-screen. Before the loadMoreFailed guard,
    // this alone was enough to retry forever. Fire it again here and confirm
    // no second network call happens.
    await fireIntersection();

    expect(secondPageAttempts).toBe(1);

    // The user can still retry deliberately.
    fireEvent.click(
      screen.getByText("Could not load more transactions. Try again.")
    );

    await waitFor(() => {
      expect(secondPageAttempts).toBe(2);
      // All 75 transactions are now loaded, so the load-more sentinel
      // (including the "Try again" control) no longer renders.
      expect(
        screen.queryByText("Could not load more transactions. Try again.")
      ).not.toBeInTheDocument();
      expect(
        (transactionListProps?.transactions as unknown[] | undefined)?.length
      ).toBe(75);
    });
  });

  it("stops auto-retrying after a load-more HTTP error and lets the user retry manually", async () => {
    // Same scenario as the network-failure test above, but the failure is
    // an HTTP error response (ok: false) rather than a rejected fetch —
    // this is the case fetchTransactionsPage used to swallow by parsing the
    // error body as an empty page, which dropped totalCount to 0 and made
    // the load-more sentinel (and any retry) disappear entirely.
    const buildTransaction = (id: number): TransactionWithSplits => ({
      id,
      bookId: 1,
      date: "2026-02-05",
      description: `Transaction ${id}`,
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
      splits: [],
      investmentSplits: [],
    });

    let observerCallback: IntersectionObserverCallback | null = null;
    const observeMock = vi.fn();
    const unobserveMock = vi.fn();

    const IntersectionObserverMock = vi.fn(function (
      this: {
        observe: (element: Element) => void;
        unobserve: (element: Element) => void;
      },
      callback: IntersectionObserverCallback
    ) {
      observerCallback = callback;
      this.observe = observeMock;
      this.unobserve = unobserveMock;
    });

    vi.stubGlobal(
      "IntersectionObserver",
      IntersectionObserverMock as unknown as typeof IntersectionObserver
    );

    const firstPage = Array.from({ length: 50 }, (_, index) =>
      buildTransaction(index + 1)
    );
    const secondPage = Array.from({ length: 25 }, (_, index) =>
      buildTransaction(index + 51)
    );

    let secondPageAttempts = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        if (url.includes("offset=50")) {
          secondPageAttempts += 1;
          if (secondPageAttempts === 1) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ error: "Internal Server Error" }),
            } as Response;
          }
          return {
            ok: true,
            json: async () => ({ transactions: secondPage, totalCount: 75 }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ transactions: firstPage, totalCount: 75 }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/positions")) {
        return { ok: true, json: async () => positionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/payees") {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/sync/stale-unmatched")) {
        return { ok: true, json: async () => ({ totalCount: 0, accounts: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/sync/pending-transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<TransactionsPage />);

    await waitFor(() => {
      expect(screen.getByText("Scroll for more")).toBeInTheDocument();
      expect(observeMock).toHaveBeenCalled();
      expect(observerCallback).not.toBeNull();
    });

    const observedElement = observeMock.mock.calls[0]?.[0] as Element | undefined;
    const fireIntersection = async () => {
      await act(async () => {
        observerCallback?.(
          [
            {
              isIntersecting: true,
              target: observedElement ?? document.createElement("div"),
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        );
      });
    };

    // First automatic trigger: the offset=50 fetch returns a 500.
    await fireIntersection();

    await waitFor(() => {
      expect(secondPageAttempts).toBe(1);
      expect(
        screen.getByText("Could not load more transactions. Try again.")
      ).toBeInTheDocument();
    });

    // Observer effect tears down and recreates (loadingMore/loadMoreFailed
    // are both in its dependency array), firing an immediate callback for a
    // sentinel that's still on-screen. Without fetchTransactionsPage
    // throwing on a non-ok response, loadMoreFailed would never have been
    // set and this would trigger a second network call.
    await fireIntersection();

    expect(secondPageAttempts).toBe(1);

    // The user can still retry deliberately.
    fireEvent.click(
      screen.getByText("Could not load more transactions. Try again.")
    );

    await waitFor(() => {
      expect(secondPageAttempts).toBe(2);
      // All 75 transactions are now loaded, so the load-more sentinel
      // (including the "Try again" control) no longer renders.
      expect(
        screen.queryByText("Could not load more transactions. Try again.")
      ).not.toBeInTheDocument();
      expect(
        (transactionListProps?.transactions as unknown[] | undefined)?.length
      ).toBe(75);
    });
  });

  it("reloads the transaction after an in-modal Plaid unlink, so the next save sends the new updatedAt", async () => {
    const original = makeTransaction({
      id: 7,
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    const reloaded = { ...original, updatedAt: new Date("2024-06-02T00:00:00.000Z") };
    const putBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/b/1/transactions/7" && method === "GET") {
        return { ok: true, json: async () => reloaded } as Response;
      }
      if (url === "/api/b/1/transactions/7" && method === "PUT") {
        putBodies.push(JSON.parse(init!.body as string));
        return { ok: true, json: async () => reloaded } as Response;
      }
      if (url.startsWith("/api/b/1/transactions/7/plaid")) {
        return { ok: true, json: async () => null } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      const standard = standardFetchResponse(url);
      if (standard) return standard;
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<TransactionsPage />);

    await waitFor(() => expect(transactionListProps?.onEdit).toBeTypeOf("function"));

    act(() => {
      (transactionListProps!.onEdit as (t: TransactionWithSplits) => void)(original);
    });

    await waitFor(() => expect(transactionFormProps?.onPlaidUnlinked).toBeTypeOf("function"));

    // The banner's unlink action, driven in-modal.
    await act(async () => {
      await (transactionFormProps!.onPlaidUnlinked as () => Promise<void>)();
    });

    // The modal's editingTransaction now carries the reloaded (newer) updatedAt.
    await waitFor(() =>
      expect(
        (transactionFormProps?.editingTransaction as TransactionWithSplits | null)?.updatedAt
      ).toEqual(reloaded.updatedAt)
    );

    await act(async () => {
      await (transactionFormProps!.onSubmit as (data: unknown) => Promise<void>)({
        date: original.date,
        description: original.description ?? "",
        splits: [],
      });
    });

    // The save must send the NEW (reloaded) updatedAt, not the stale one the
    // modal opened with — otherwise the server refuses it as a conflict.
    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].expectedUpdatedAt).toBe(reloaded.updatedAt.toISOString());
  });

  it("shows the conflict toast and closes the modal on a 409 save", async () => {
    const editing = makeTransaction({
      id: 8,
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/b/1/transactions/8" && method === "PUT") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: TRANSACTION_CONFLICT_MESSAGE }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions/8/plaid")) {
        return { ok: true, json: async () => null } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      const standard = standardFetchResponse(url);
      if (standard) return standard;
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<TransactionsPage />);

    await waitFor(() => expect(transactionListProps?.onEdit).toBeTypeOf("function"));

    act(() => {
      (transactionListProps!.onEdit as (t: TransactionWithSplits) => void)(editing);
    });

    await waitFor(() => expect(transactionFormProps?.onSubmit).toBeTypeOf("function"));
    expect(screen.getByTestId("edit-transaction-form")).toBeInTheDocument();

    await act(async () => {
      await (transactionFormProps!.onSubmit as (data: unknown) => Promise<void>)({
        date: editing.date,
        description: editing.description ?? "",
        splits: [],
      });
    });

    expect(toast.error).toHaveBeenCalledWith(TRANSACTION_CONFLICT_MESSAGE);
    await waitFor(() =>
      expect(screen.queryByTestId("edit-transaction-form")).not.toBeInTheDocument()
    );
  });

  it("merges the reconcile toggle's updatedAt, so the next save is not treated as a conflict", async () => {
    const original = makeTransaction({
      id: 9,
      isReconciled: false,
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    const afterToggle = {
      ...original,
      isReconciled: true,
      updatedAt: new Date("2024-06-03T00:00:00.000Z"),
      updatedBy: 5,
    };
    const putBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/b/1/transactions/9" && method === "PUT") {
        putBodies.push(JSON.parse(init!.body as string));
        return { ok: true, json: async () => afterToggle } as Response;
      }
      if (url.startsWith("/api/b/1/transactions/9/plaid")) {
        return { ok: true, json: async () => null } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => ({ transactions: [original], startingBalance: 0, totalCount: 1 }),
        } as Response;
      }
      const standard = standardFetchResponse(url);
      if (standard) return standard;
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<TransactionsPage />);

    await waitFor(() => {
      expect(transactionListProps?.onToggleReconciled).toBeTypeOf("function");
      expect(
        (transactionListProps?.transactions as TransactionWithSplits[] | undefined)?.some(
          (t) => t.id === 9
        )
      ).toBe(true);
    });

    await act(async () => {
      await (
        transactionListProps!.onToggleReconciled as (
          id: number,
          reconciled: boolean
        ) => Promise<void>
      )(9, true);
    });

    await waitFor(() => {
      const row = (transactionListProps?.transactions as TransactionWithSplits[]).find(
        (t) => t.id === 9
      );
      expect(row?.updatedAt).toEqual(afterToggle.updatedAt);
    });

    const rowAfterToggle = (
      transactionListProps!.transactions as TransactionWithSplits[]
    ).find((t) => t.id === 9)!;

    act(() => {
      (transactionListProps!.onEdit as (t: TransactionWithSplits) => void)(rowAfterToggle);
    });

    await waitFor(() => expect(transactionFormProps?.onSubmit).toBeTypeOf("function"));

    await act(async () => {
      await (transactionFormProps!.onSubmit as (data: unknown) => Promise<void>)({
        date: original.date,
        description: original.description ?? "",
        splits: [],
      });
    });

    // First PUT was the reconcile toggle (no expectedUpdatedAt); second is the
    // modal save, which must carry the toggle response's updatedAt rather
    // than the stale value the row had when the modal first opened.
    expect(putBodies).toHaveLength(2);
    expect(putBodies[1].expectedUpdatedAt).toBe(afterToggle.updatedAt.toISOString());
  });
  describe("balance chart", () => {
    const checking = {
      id: 3,
      name: "Checking",
      type: "asset",
      subtype: "bank",
      parentId: null,
      isFavorite: false,
      isInvestmentCash: false,
      icon: null,
      balance: 0,
    };

    function stubFetch() {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/b/1/accounts")) {
          return { ok: true, json: async () => [...accountsPayload, checking] } as Response;
        }
        if (url.startsWith("/api/b/1/transactions")) {
          return { ok: true, json: async () => transactionsPayload } as Response;
        }
        const standard = standardFetchResponse(url);
        if (standard) return standard;
        throw new Error(`Unexpected fetch url: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    it("shows the chart for one selected account that is not an investment account", async () => {
      searchParamsValue = new URLSearchParams("accountId=3");
      stubFetch();
      render(<TransactionsPage />);
      expect(await screen.findByTestId("account-balance-chart")).toBeInTheDocument();
      expect(balanceChartProps).toMatchObject({ bookId: "1", accountId: 3, accountType: "asset" });
      expect(typeof balanceChartProps?.refreshKey).toBe("number");
    });

    it("gives the chart a new refreshKey after a reconcile toggle", async () => {
      searchParamsValue = new URLSearchParams("accountId=3");
      const transaction = makeTransaction({ id: 9, isReconciled: false });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/b/1/transactions/9" && method === "PUT") {
          return { ok: true, json: async () => ({ ...transaction, isReconciled: true }) } as Response;
        }
        if (url.startsWith("/api/b/1/accounts")) {
          return { ok: true, json: async () => [...accountsPayload, checking] } as Response;
        }
        if (url.startsWith("/api/b/1/transactions")) {
          return {
            ok: true,
            json: async () => ({ transactions: [transaction], startingBalance: 0, totalCount: 1 }),
          } as Response;
        }
        const standard = standardFetchResponse(url);
        if (standard) return standard;
        throw new Error(`Unexpected fetch url: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<TransactionsPage />);
      await screen.findByTestId("account-balance-chart");
      await waitFor(() => expect(transactionListProps?.onToggleReconciled).toBeTypeOf("function"));
      const before = balanceChartProps?.refreshKey as number;
      await act(async () => {
        await (transactionListProps!.onToggleReconciled as (id: number, reconciled: boolean) => Promise<void>)(9, true);
      });
      await waitFor(() => expect(balanceChartProps?.refreshKey).toBe(before + 1));
    });

    it("shows no chart for All Transactions", async () => {
      searchParamsValue = new URLSearchParams("");
      stubFetch();
      render(<TransactionsPage />);
      await waitFor(() => expect(transactionListProps?.isLoading).toBe(false));
      expect(screen.getByRole("heading", { name: "All Transactions" })).toBeInTheDocument();
      expect(screen.queryByTestId("account-balance-chart")).not.toBeInTheDocument();
    });

    it("shows no chart for an investment account", async () => {
      searchParamsValue = new URLSearchParams("accountId=1");
      stubFetch();
      render(<TransactionsPage />);
      expect(await screen.findByRole("heading", { name: "Vanguard 401(k)" })).toBeInTheDocument();
      await waitFor(() => expect(transactionListProps?.isLoading).toBe(false));
      expect(screen.queryByTestId("account-balance-chart")).not.toBeInTheDocument();
    });
  });
});
