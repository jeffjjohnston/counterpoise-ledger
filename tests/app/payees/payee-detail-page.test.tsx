import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PayeeDetailPage from "@/app/b/[bookId]/payees/[id]/page";
import type { TransactionWithSplits } from "@/types";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1", id: "1" }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/transactions/TransactionList", () => ({
  TransactionList: ({
    transactions,
    onEdit,
  }: {
    transactions: TransactionWithSplits[];
    onEdit: (transaction: TransactionWithSplits) => void;
  }) => (
    <div>
      <div data-testid="transaction-count">{transactions.length}</div>
      <button
        type="button"
        onClick={() => transactions[0] && onEdit(transactions[0])}
        disabled={!transactions[0]}
      >
        Open transaction editor
      </button>
    </div>
  ),
}));

vi.mock("@/components/transactions/TransactionForm", () => ({
  TransactionForm: ({
    editingTransaction,
  }: {
    editingTransaction?: TransactionWithSplits | null;
  }) => (
    <div data-testid="transaction-form">
      Editing transaction {editingTransaction?.id ?? "none"}
    </div>
  ),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

describe("PayeeDetailPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const buildTransaction = (id: number): TransactionWithSplits => ({
    id,
    bookId: 1,
    date: "2026-02-05",
    description: `Transaction ${id}`,
    checkNumber: null,
    notes: null,
    payeeId: 1,
    isReconciled: false,
    isFloating: false,
    recurringRuleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    payee: { id: 1, bookId: 1, name: "Blue Bottle", createdAt: new Date() },
    splits: [],
    investmentSplits: [],
  });

  it("opens the edit transaction modal when a transaction row is clicked", async () => {
    const transaction = buildTransaction(101);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/payees/1") {
        return {
          ok: true,
          json: async () => ({ id: 1, name: "Blue Bottle", transactionCount: 1 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true"
      ) {
        return {
          ok: true,
          json: async () => ({ transactions: [transaction], totalCount: 1 }),
        } as Response;
      }
      if (url === "/api/b/1/accounts?includeInactive=true") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Open transaction editor")).toBeInTheDocument();
    });

    const transactionCalls = fetchMock.mock.calls
      .map(([input]) => (typeof input === "string" ? input : input.toString()))
      .filter((url) => url.startsWith("/api/b/1/transactions?"));
    expect(transactionCalls).toEqual([
      "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true",
    ]);

    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Open transaction editor"));

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-form")).toHaveTextContent("Editing transaction 101");
  });

  it("loads additional transactions when the infinite-scroll sentinel intersects", async () => {
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

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/payees/1") {
        return {
          ok: true,
          json: async () => ({ id: 1, name: "Blue Bottle", transactionCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true"
      ) {
        return {
          ok: true,
          json: async () => ({ transactions: firstPage, totalCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=50&includeMeta=true"
      ) {
        return {
          ok: true,
          json: async () => ({ transactions: secondPage, totalCount: 75 }),
        } as Response;
      }
      if (url === "/api/b/1/accounts?includeInactive=true") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Scroll for more")).toBeInTheDocument();
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("50");
      expect(observeMock).toHaveBeenCalled();
      expect(observerCallback).not.toBeNull();
    });

    const observedElement = observeMock.mock.calls[0]?.[0] as Element | undefined;

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

    await waitFor(() => {
      const transactionCalls = fetchMock.mock.calls
        .map(([request]) =>
          typeof request === "string" ? request : request.toString()
        )
        .filter((url) => url.startsWith("/api/b/1/transactions?"));

      expect(transactionCalls).toEqual([
        "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true",
        "/api/b/1/transactions?payeeId=1&limit=50&offset=50&includeMeta=true",
      ]);
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("75");
    });
  });

  it("stops auto-retrying after a failed \"load more\" and lets the user retry manually", async () => {
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
      if (url === "/api/b/1/payees/1") {
        return {
          ok: true,
          json: async () => ({ id: 1, name: "Blue Bottle", transactionCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true"
      ) {
        return {
          ok: true,
          json: async () => ({ transactions: firstPage, totalCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=50&includeMeta=true"
      ) {
        secondPageAttempts += 1;
        if (secondPageAttempts === 1) {
          throw new Error("network down");
        }
        return {
          ok: true,
          json: async () => ({ transactions: secondPage, totalCount: 75 }),
        } as Response;
      }
      if (url === "/api/b/1/accounts?includeInactive=true") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeeDetailPage />);

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
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("75");
    });
  });

  it("stops auto-retrying after a load-more HTTP error and lets the user retry manually", async () => {
    // Same scenario as the network-failure test above, but the failure is
    // an HTTP error response (ok: false) rather than a rejected fetch —
    // this is the case fetchTransactionsPage used to swallow by returning
    // instead of throwing, which let the observer retry unbounded.
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
      if (url === "/api/b/1/payees/1") {
        return {
          ok: true,
          json: async () => ({ id: 1, name: "Blue Bottle", transactionCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=0&includeMeta=true"
      ) {
        return {
          ok: true,
          json: async () => ({ transactions: firstPage, totalCount: 75 }),
        } as Response;
      }
      if (
        url ===
        "/api/b/1/transactions?payeeId=1&limit=50&offset=50&includeMeta=true"
      ) {
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
      if (url === "/api/b/1/accounts?includeInactive=true") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeeDetailPage />);

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
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("75");
    });
  });
});
