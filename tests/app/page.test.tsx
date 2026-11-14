import { act, render, screen, waitFor, within } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import HomePage from "@/app/b/[bookId]/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

const accountsPayload = [
  {
    id: 1,
    name: "Fidelity 401(k)",
    type: "asset",
    subtype: "investment",
    parentId: null,
    isInvestmentCash: false,
    icon: null,
    isActive: true,
    balance: 50000,
    children: [
      {
        id: 2,
        name: "Fidelity Cash",
        type: "asset",
        subtype: "cash",
        parentId: 1,
        isInvestmentCash: true,
        icon: null,
        isActive: true,
        balance: 1000,
      },
    ],
  },
  {
    id: 3,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isInvestmentCash: false,
    icon: null,
    isActive: true,
    balance: 250000,
  },
];

describe("HomePage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides investment cash accounts in the assets list", async () => {
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
          json: async () => [],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("Fidelity 401(k)")).toBeInTheDocument();
    });

    expect(screen.queryByText("Fidelity Cash")).not.toBeInTheDocument();
    expect(screen.getByText("Cash $10.00")).toBeInTheDocument();
  });

  it("shows hand-calculated assets, liabilities, and net worth without counting investment cash twice", async () => {
    const accounts = [
      ...accountsPayload,
      {
        id: 4,
        name: "Credit Card",
        type: "liability",
        subtype: "credit_card",
        parentId: null,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: -50000,
      },
    ];
    // Checking $2,500 + investments $400 market value + $10 cash = $2,910.
    // The investment account's $500 cost basis is not its market value, and
    // its $10 cash child is already included in the investment effective balance.
    // A $500 credit balance leaves $2,410 net worth.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accounts } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [{ accountId: 1, marketValueCents: 40000 }] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("Net Worth").parentElement).toHaveTextContent("$2,410.00");
    });
    expect(screen.getByText("Assets", { selector: "p" }).parentElement).toHaveTextContent("$2,910.00");
    expect(screen.getByText("Liabilities", { selector: "p" }).parentElement).toHaveTextContent("$500.00");
  });

  it("uses book-scoped transaction links for account rows", async () => {
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
          json: async () => [],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Checking" })).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Checking" })).toHaveAttribute(
      "href",
      "/b/1/transactions?accountId=3"
    );
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("shows payee name instead of description in recent transactions", async () => {
    const transactionsPayload = [
      {
        id: 10,
        date: "2026-03-01",
        description: "Monthly groceries",
        payeeId: 1,
        payee: { id: 1, name: "Whole Foods", bookId: 1 },
        splits: [
          { id: 1, amount: -5000, account: { id: 3, name: "Checking", type: "asset" } },
          { id: 2, amount: 5000, account: { id: 4, name: "Groceries", type: "expense" } },
        ],
        investmentSplits: [],
      },
      {
        id: 11,
        date: "2026-03-02",
        description: "ATM withdrawal",
        payeeId: null,
        payee: null,
        splits: [
          { id: 3, amount: -10000, account: { id: 3, name: "Checking", type: "asset" } },
          { id: 4, amount: 10000, account: { id: 5, name: "Cash", type: "asset" } },
        ],
        investmentSplits: [],
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      // Transaction with payee: shows payee name as primary label
      expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    });

    // Transaction without payee: falls back to description
    expect(screen.getByText("ATM withdrawal")).toBeInTheDocument();

    // Description should NOT appear as the primary label when payee exists
    expect(screen.queryByText("Monthly groceries")).not.toBeInTheDocument();
  });
  it("links each recent transaction to the register of its asset or liability account", async () => {
    // The register without accountId opens the favorite account and drops
    // highlight, so each link must name an account.
    const transactionsPayload = [
      {
        id: 20,
        date: "2026-03-03",
        description: "Card purchase",
        payeeId: null,
        payee: null,
        splits: [
          { id: 5, amount: 2500, account: { id: 4, name: "Groceries", type: "expense" } },
          { id: 6, amount: -2500, account: { id: 7, name: "Visa", type: "liability" } },
        ],
        investmentSplits: [],
      },
      {
        id: 21,
        date: "2026-03-04",
        description: "Transfer to savings",
        payeeId: null,
        payee: null,
        splits: [
          { id: 7, amount: -1000, account: { id: 3, name: "Checking", type: "asset" } },
          { id: 8, amount: 1000, account: { id: 8, name: "Savings", type: "asset" } },
        ],
        investmentSplits: [],
      },
      {
        id: 22,
        date: "2026-03-05",
        description: "Opening entry",
        payeeId: null,
        payee: null,
        splits: [
          { id: 9, amount: 500, account: { id: 4, name: "Groceries", type: "expense" } },
          { id: 10, amount: -500, account: { id: 9, name: "Salary", type: "income" } },
        ],
        investmentSplits: [],
      },
    ];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }));

    render(<HomePage />);

    const card = await screen.findByText("Card purchase");
    expect(card.closest("a")).toHaveAttribute("href", "/b/1/transactions?accountId=7&highlight=20");
    expect(screen.getByText("Transfer to savings").closest("a")).toHaveAttribute(
      "href",
      "/b/1/transactions?accountId=3&highlight=21"
    );
    // No asset or liability split: the first split's account has a register too.
    expect(screen.getByText("Opening entry").closest("a")).toHaveAttribute(
      "href",
      "/b/1/transactions?accountId=4&highlight=22"
    );
  });
});

// Another client (an MCP tool, a second tab, a scheduled job) changes the
// book. The server sends the book socket a hint for each changed table, and
// the dashboard must show the change without a reload.
describe("HomePage live updates", () => {
  const transaction = (id: number, payee: string) => ({
    id,
    date: "2026-02-05",
    description: "",
    payee: { id, name: payee },
    splits: [
      { id: id * 10, amount: 1234, account: { id: 3, name: "Checking", type: "asset" } },
      { id: id * 10 + 1, amount: -1234, account: { id: 9, name: "Income", type: "income" } },
    ],
  });

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
      <ToastProvider>
        <BookChangesProvider>
          <HomePage />
        </BookChangesProvider>
      </ToastProvider>
    );
  }

  /** A fetch mock that answers from the given values, read at each request. */
  function serve(data: {
    accounts: () => unknown;
    transactions: () => unknown;
    netWorth?: () => unknown;
  }) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (body: unknown, ok = true) =>
        ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
      if (url.startsWith("/api/b/1/accounts")) {
        const body = data.accounts();
        return body instanceof Error ? json({ error: "down" }, false) : json(body);
      }
      if (url.startsWith("/api/b/1/transactions")) return json(data.transactions());
      if (url.startsWith("/api/b/1/investments/account-values")) return json([]);
      if (url.startsWith("/api/b/1/reports/net-worth-history")) {
        return json(data.netWorth ? data.netWorth() : { points: [] });
      }
      if (url.startsWith("/api/b/1/weekly-review")) return json({ configured: false });
      throw new Error(`Unexpected fetch url: ${url}`);
    });
  }

  function accountCalls(fetchMock: ReturnType<typeof serve>) {
    return fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/b/1/accounts")).length;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a transaction and a balance that another client wrote", async () => {
    let rows: unknown[] = [transaction(1, "Blue Bottle")];
    let accounts: unknown = accountsPayload;
    vi.stubGlobal("fetch", serve({ accounts: () => accounts, transactions: () => rows }));

    renderLive();
    await screen.findByText("Blue Bottle");
    expect(screen.queryByText("City Utilities")).not.toBeInTheDocument();

    rows = [transaction(2, "City Utilities"), ...rows];
    accounts = accountsPayload.map((row) => (row.id === 3 ? { ...row, balance: 987654 } : row));
    hint(["transactions", "transaction_splits"]);

    expect(await screen.findByText("City Utilities")).toBeInTheDocument();
    expect((await screen.findAllByText("$9,876.54")).length).toBeGreaterThan(0);
    // A background reload does not show the loading skeleton.
    expect(screen.getByText("Blue Bottle")).toBeInTheDocument();
  });

  it("does not reload for a table that it does not show", async () => {
    const fetchMock = serve({ accounts: () => accountsPayload, transactions: () => [] });
    vi.stubGlobal("fetch", fetchMock);

    renderLive();
    await screen.findByText("Checking");
    const before = accountCalls(fetchMock);

    hint(["recurring_rules", "plaid_accounts"]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

    expect(accountCalls(fetchMock)).toBe(before);
  });

  it("keeps the dashboard when a background reload fails", async () => {
    let accounts: unknown = accountsPayload;
    const fetchMock = serve({ accounts: () => accounts, transactions: () => [] });
    vi.stubGlobal("fetch", fetchMock);

    renderLive();
    await screen.findByText("Checking");
    const before = accountCalls(fetchMock);

    accounts = new Error("down");
    hint(["accounts"]);

    expect(await screen.findByText("Could not refresh the dashboard.")).toBeInTheDocument();
    expect(accountCalls(fetchMock)).toBe(before + 1);
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.queryByText("Could not load dashboard data.")).not.toBeInTheDocument();
  });

  it("reloads the net worth chart when another client changes a split", async () => {
    stubResizeObserver(600);
    let points = [
      { date: "2026-08-31", netWorthCents: 111_111 },
      { date: "2026-09-30", netWorthCents: 222_222 },
    ];
    vi.stubGlobal("fetch", serve({
      accounts: () => accountsPayload,
      transactions: () => [],
      netWorth: () => ({ points }),
    }));

    renderLive();
    const table = () => screen.getByRole("table", { hidden: true, name: "Net worth by date" });
    await waitFor(() => expect(within(table()).getByText("$2,222.22")).toBeInTheDocument());

    points = [points[0], { date: "2026-09-30", netWorthCents: 333_333 }];
    hint(["transaction_splits"]);

    await waitFor(() => expect(within(table()).getByText("$3,333.33")).toBeInTheDocument());
    expect(screen.queryByTestId("net-worth-placeholder")).not.toBeInTheDocument();
  });
});
