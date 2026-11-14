import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PayeeDetailPage from "@/app/b/[bookId]/payees/[id]/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";
import type { TransactionWithSplits } from "@/types";

const mockPush = vi.fn();
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1", id: "1" }),
    useRouter: () => ({ push: mockPush }),
  })
);

// The chart has its own test (tests/components/payees/PayeeSpendingChart.test.tsx).
vi.mock("@/components/payees/PayeeSpendingChart", () => ({
  PayeeSpendingChart: ({ bookId, payeeId, refreshKey }: { bookId: string; payeeId: number; refreshKey: number }) => (
    <div data-testid="payee-spending-chart" data-refresh-key={refreshKey}>{bookId}/{payeeId}</div>
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
    onSubmit,
    onDelete,
    onCancel,
  }: {
    editingTransaction?: TransactionWithSplits | null;
    onSubmit: (data: unknown) => void;
    onDelete?: () => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="transaction-form">
      Editing transaction {editingTransaction?.id ?? "none"}
      <button type="button" onClick={() => onSubmit({ date: "2026-02-05", description: "Changed", splits: [] })}>
        Save transaction
      </button>
      <button type="button" onClick={() => onDelete?.()}>Delete transaction</button>
      <button type="button" onClick={() => onCancel?.()}>Cancel edit</button>
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
    createdBy: null,
    updatedBy: null,
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

    // The chart goes between the header and the transaction list.
    const chart = screen.getByTestId("payee-spending-chart");
    expect(chart).toHaveTextContent("1/1");
    expect(chart.compareDocumentPosition(screen.getByTestId("transaction-count")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Open transaction editor"));

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-form")).toHaveTextContent("Editing transaction 101");
  });

  it("gives the chart a new refreshKey after a save and after a delete", async () => {
    const transaction = buildTransaction(101);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") return { ok: true, json: async () => transaction } as Response;
      if (method === "DELETE") return { ok: true, json: async () => ({}) } as Response;
      if (url === "/api/b/1/payees/1") {
        return { ok: true, json: async () => ({ id: 1, name: "Blue Bottle", transactionCount: 1 }) } as Response;
      }
      if (url.startsWith("/api/b/1/transactions?")) {
        return { ok: true, json: async () => ({ transactions: [transaction], totalCount: 1 }) } as Response;
      }
      if (url === "/api/b/1/accounts?includeInactive=true") return { ok: true, json: async () => [] } as Response;
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    render(<PayeeDetailPage />);
    await waitFor(() => expect(screen.getByText("Open transaction editor")).toBeInTheDocument());
    const key = () => screen.getByTestId("payee-spending-chart").getAttribute("data-refresh-key");
    expect(key()).toBe("0");

    fireEvent.click(screen.getByText("Open transaction editor"));
    fireEvent.click(screen.getByText("Save transaction"));
    await waitFor(() => expect(key()).toBe("1"));
    await waitFor(() => expect(screen.queryByTestId("modal")).not.toBeInTheDocument());

    fireEvent.click(screen.getByText("Open transaction editor"));
    fireEvent.click(screen.getByText("Delete transaction"));
    await waitFor(() => expect(key()).toBe("2"));
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

  // Another client (an MCP tool, a second tab, a scheduled job) changes the
  // book. The server sends the book socket a hint for each changed table, and
  // the page must show the change without a reload.
  describe("live updates", () => {
    function socket() {
      return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }

    function hint(tables: string[]) {
      act(() => { socket().emit("change", { tables }); });
    }

    function renderLive() {
      FakeWebSocket.instances = [];
      vi.stubGlobal("WebSocket", FakeWebSocket);
      return render(
        <BookChangesProvider>
          <PayeeDetailPage />
        </BookChangesProvider>
      );
    }

    /** A fetch mock that reads the payee and its transactions at each request. */
    function serve(data: { payee: () => unknown; transactions: () => TransactionWithSplits[] }) {
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/b/1/payees/1") {
          const body = data.payee();
          if (typeof body === "number") {
            return { ok: false, status: body, json: async () => ({ error: "failed" }) } as Response;
          }
          return { ok: true, status: 200, json: async () => body } as Response;
        }
        if (url.startsWith("/api/b/1/transactions?")) {
          const rows = data.transactions();
          return { ok: true, status: 200, json: async () => ({ transactions: rows, totalCount: rows.length }) } as Response;
        }
        if (url === "/api/b/1/accounts?includeInactive=true") {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        throw new Error(`Unexpected fetch url: ${url}`);
      });
    }

    function transactionCalls(fetchMock: ReturnType<typeof serve>) {
      return fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/b/1/transactions?")).length;
    }

    const blueBottle = (transactionCount: number) => ({ id: 1, name: "Blue Bottle", transactionCount });

    it("adds no old rows when a load more starts during a reload", async () => {
      let observerCallback: IntersectionObserverCallback | null = null;
      vi.stubGlobal("IntersectionObserver", vi.fn(function (
        this: { observe: () => void; unobserve: () => void },
        callback: IntersectionObserverCallback
      ) {
        observerCallback = callback;
        this.observe = () => {};
        this.unobserve = () => {};
      }) as unknown as typeof IntersectionObserver);
      let rows = Array.from({ length: 75 }, (_, index) => buildTransaction(index + 1));
      // The test holds the requests of the reload and of the load more, and
      // releases them in the order that it chooses.
      const held: Record<string, () => void> = {};
      let holding = false;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/b/1/payees/1") {
          return { ok: true, status: 200, json: async () => blueBottle(rows.length) } as Response;
        }
        if (url.startsWith("/api/b/1/transactions?")) {
          const params = new URL(url, "http://localhost").searchParams;
          const offset = Number(params.get("offset"));
          const captured = rows.slice(offset, offset + Number(params.get("limit")));
          const total = rows.length;
          if (holding) await new Promise<void>((resolve) => { held[String(offset)] = resolve; });
          return { ok: true, status: 200, json: async () => ({ transactions: captured, totalCount: total }) } as Response;
        }
        return { ok: true, status: 200, json: async () => [] } as Response;
      }));

      renderLive();
      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("50"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 150)));

      // Another client adds a transaction at the top of the list.
      rows = [buildTransaction(200), ...rows];
      holding = true;
      hint(["transactions"]);
      await waitFor(() => expect(held["0"]).toBeDefined());
      const intersect = observerCallback as IntersectionObserverCallback | null;
      await act(async () => {
        intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      holding = false;
      await act(async () => { held["0"](); });
      held["50"]?.();

      // The reload gave the first 50 rows of the new list. The rows after the
      // old list do not go on the end of it.
      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("50"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("50");
    });

    it("shows a transaction that another client added, and refreshes the chart", async () => {
      let rows = [buildTransaction(101)];
      vi.stubGlobal("fetch", serve({ payee: () => blueBottle(rows.length), transactions: () => rows }));

      renderLive();
      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("1"));
      const key = () => screen.getByTestId("payee-spending-chart").getAttribute("data-refresh-key");
      expect(key()).toBe("0");

      rows = [buildTransaction(102), ...rows];
      hint(["transactions", "transaction_splits"]);

      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("2"));
      expect(screen.getByText("2 transactions")).toBeInTheDocument();
      expect(key()).toBe("1");
    });

    it("does not reload for a table that it does not show", async () => {
      const fetchMock = serve({ payee: () => blueBottle(1), transactions: () => [buildTransaction(101)] });
      vi.stubGlobal("fetch", fetchMock);

      renderLive();
      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("1"));
      const before = transactionCalls(fetchMock);

      hint(["recurring_rules", "security_prices", "plaid_accounts"]);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

      expect(transactionCalls(fetchMock)).toBe(before);
    });

    it("keeps the open editor during a change, and reloads after it closes", async () => {
      let rows = [buildTransaction(101)];
      const fetchMock = serve({ payee: () => blueBottle(rows.length), transactions: () => rows });
      vi.stubGlobal("fetch", fetchMock);

      renderLive();
      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("1"));
      fireEvent.click(screen.getByText("Open transaction editor"));
      expect(screen.getByTestId("transaction-form")).toHaveTextContent("Editing transaction 101");
      const before = transactionCalls(fetchMock);

      rows = [buildTransaction(102), ...rows];
      hint(["transactions"]);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

      // The draft stays, and the page did not ask for the new data.
      expect(transactionCalls(fetchMock)).toBe(before);
      expect(screen.getByTestId("transaction-form")).toHaveTextContent("Editing transaction 101");
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("1");

      fireEvent.click(screen.getByText("Cancel edit"));

      await waitFor(() => expect(screen.getByTestId("transaction-count")).toHaveTextContent("2"));
      expect(transactionCalls(fetchMock)).toBe(before + 1);
    });

    it("shows the not-found state when another client deletes the payee", async () => {
      let payee: unknown = blueBottle(0);
      const fetchMock = serve({ payee: () => payee, transactions: () => [] });
      vi.stubGlobal("fetch", fetchMock);

      renderLive();
      expect(await screen.findByRole("heading", { name: "Blue Bottle" })).toBeInTheDocument();
      const before = transactionCalls(fetchMock);

      payee = 404;
      hint(["payees"]);

      expect(await screen.findByText("Payee not found.")).toBeInTheDocument();
      // The transaction list refuses the id of a deleted payee, so the page
      // does not ask for it.
      expect(transactionCalls(fetchMock)).toBe(before);
    });

    it("keeps the payee on the screen when a background reload fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      let payee: unknown = blueBottle(1);
      vi.stubGlobal("fetch", serve({ payee: () => payee, transactions: () => [buildTransaction(101)] }));

      renderLive();
      expect(await screen.findByRole("heading", { name: "Blue Bottle" })).toBeInTheDocument();

      payee = 500;
      hint(["payees"]);

      await waitFor(() => expect(consoleError).toHaveBeenCalledWith("Could not refresh payee data."));
      expect(screen.getByRole("heading", { name: "Blue Bottle" })).toBeInTheDocument();
      expect(screen.queryByText("Payee not found.")).not.toBeInTheDocument();
      expect(screen.queryByText("Could not load payee.")).not.toBeInTheDocument();
    });
  });
});
