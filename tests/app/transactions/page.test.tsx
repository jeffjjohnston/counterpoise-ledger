import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import TransactionsPage from "@/app/b/[bookId]/transactions/page";
import { PRICES_SAVED_EVENT } from "@/lib/events";
import { toDateString } from "@/lib/formatters";
import type { TransactionWithSplits } from "@/types";

const pushMock = vi.fn();
const replaceMock = vi.fn();
let transactionListProps: Record<string, unknown> | null = null;
let searchParamsValue = new URLSearchParams("accountId=1");

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
  TransactionList: (props: Record<string, unknown>) => {
    transactionListProps = props;
    return <div data-testid="transaction-list" />;
  },
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

describe("TransactionsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    transactionListProps = null;
    searchParamsValue = new URLSearchParams("accountId=1");
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
});
