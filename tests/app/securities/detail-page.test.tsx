import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecurityDetailPage from "@/app/b/[bookId]/securities/[id]/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1", id: "4" }),
  })
);

// The page reads the role from the book layout. Each test starts as an owner.
const OWNER_ROLE = { canWrite: true, isOwner: true, role: "owner" };
let bookRoleValue: { canWrite: boolean; isOwner: boolean; role: string } = OWNER_ROLE;

vi.mock("@/components/BookRoleProvider", () => ({
  useBookRole: () => bookRoleValue,
}));

const security = {
  id: 4,
  bookId: 1,
  name: "Vanguard Total Stock Market",
  symbol: "VTI",
  securityType: "etf",
  fetchPrices: true,
  fixedPriceMicros: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  latestPriceMicros: 250_000_000,
  latestPriceDate: "2024-03-01",
};

// One stock split and one price entry: the two kinds of row that open an
// edit form for a user who can write.
const stockSplit = {
  id: 90,
  transactionId: 900,
  transactionDate: "2024-02-15",
  transactionDescription: "VTI split",
  accountId: 3,
  accountName: "Brokerage",
  action: "split",
  sharesMicros: 0,
  priceMicros: 0,
  feesCents: 0,
  splitNumerator: 2,
  splitDenominator: 1,
};

const priceEntry = { priceDate: "2024-03-01", priceMicros: 250_000_000, source: "manual" };

const CHART_PREFIX = "/api/b/1/securities/4/prices?limit=5000";

// The price table pages by 50. The price chart asks for up to 5000 rows.
let chartPrices: unknown[] = [priceEntry];
let detailSecurity: Record<string, unknown> = security;

function chartUrls() {
  return vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith(CHART_PREFIX));
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/securities/4/detail") {
        return { ok: true, json: async () => ({ security: detailSecurity, positionsByAccount: [] }) } as Response;
      }
      if (url.startsWith(CHART_PREFIX)) {
        return { ok: true, json: async () => ({ prices: chartPrices, totalCount: chartPrices.length }) } as Response;
      }
      if (init?.method === "PUT" && url === "/api/b/1/securities/4/prices/2024-03-01") {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/prices?")) {
        return { ok: true, json: async () => ({ prices: [priceEntry], totalCount: 1 }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/splits?")) {
        return { ok: true, json: async () => ({ splits: [stockSplit], totalCount: 1 }) } as Response;
      }
      if (url === "/api/b/1/securities/4/lots") {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    })
  );
}

async function renderPage() {
  stubFetch();
  render(<SecurityDetailPage />);
  await screen.findByRole("heading", { name: "Vanguard Total Stock Market" });
  const splitRow = screen.getByText("2-for-1").closest("tr")!;
  const priceRow = screen.getByText("manual").closest("tr")!;
  return { splitRow, priceRow };
}

describe("SecurityDetailPage row access", () => {
  beforeEach(() => stubResizeObserver(600));
  afterEach(() => {
    vi.unstubAllGlobals();
    bookRoleValue = OWNER_ROLE;
    chartPrices = [priceEntry];
    detailSecurity = security;
    localStorage.clear();
  });

  // The pointer cursor is the contract here: it tells the user that the row
  // opens. A row that does not open must not show it.
  it("gives an owner split and price rows that open an edit form", async () => {
    const { splitRow, priceRow } = await renderPage();

    expect(splitRow).toHaveClass("cursor-pointer");
    expect(priceRow).toHaveClass("cursor-pointer");

    fireEvent.click(priceRow);
    expect(await screen.findByRole("heading", { name: "Edit Price Entry" })).toBeInTheDocument();
  });

  it("gives a viewer split and price rows with no pointer cursor, which do not open", async () => {
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };
    const { splitRow, priceRow } = await renderPage();

    expect(splitRow).not.toHaveClass("cursor-pointer");
    expect(priceRow).not.toHaveClass("cursor-pointer");

    fireEvent.click(splitRow);
    fireEvent.click(priceRow);
    expect(screen.queryByRole("heading", { name: "Edit Stock Split" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Edit Price Entry" })).not.toBeInTheDocument();
  });
});

describe("SecurityDetailPage price chart", () => {
  const twoPrices = [
    { priceDate: "2026-03-01", priceMicros: 12_000_000, source: null },
    { priceDate: "2026-02-01", priceMicros: 10_000_000, source: null },
  ];

  beforeEach(() => {
    stubResizeObserver(600);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T23:30:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    bookRoleValue = OWNER_ROLE;
    chartPrices = [priceEntry];
    detailSecurity = security;
    localStorage.clear();
  });

  it("asks for the prices of the chosen range, apart from the price table", async () => {
    chartPrices = twoPrices;
    await renderPage();
    await screen.findByRole("img", { name: /^Price, last year:/ });
    expect(chartUrls()).toEqual(["/api/b/1/securities/4/prices?limit=5000&startDate=2025-10-02"]);

    fireEvent.click(screen.getByRole("button", { name: "5Y" }));
    await screen.findByRole("img", { name: /^Price, last 5 years:/ });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByRole("img", { name: /^Price, all history:/ });
    expect(chartUrls()).toEqual([
      "/api/b/1/securities/4/prices?limit=5000&startDate=2025-10-02",
      "/api/b/1/securities/4/prices?limit=5000&startDate=2021-10-02",
      "/api/b/1/securities/4/prices?limit=5000",
    ]);
    expect(screen.getByRole("img", { name: /from \$10\.00 on Feb 1, 2026 to \$12\.00 on Mar 1, 2026/ }))
      .toBeInTheDocument();
  });

  it("says so when there are fewer than two prices", async () => {
    chartPrices = [priceEntry];
    await renderPage();
    expect(await screen.findByText("Not enough prices to chart yet.")).toBeInTheDocument();
  });

  it("shows no chart card for a fixed-price security", async () => {
    detailSecurity = { ...security, fixedPriceMicros: 1_000_000 };
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Price history" })).not.toBeInTheDocument();
    expect(chartUrls()).toEqual([]);
  });

  it("sends no chart request while the chart is hidden", async () => {
    localStorage.setItem("counterpoise.priceHistoryChart.hidden", "true");
    await renderPage();
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
    expect(chartUrls()).toEqual([]);
  });

  it("fetches the chart prices again after a price edit", async () => {
    chartPrices = twoPrices;
    const { priceRow } = await renderPage();
    await screen.findByRole("img", { name: /^Price, last year:/ });
    expect(chartUrls()).toHaveLength(1);

    fireEvent.click(priceRow);
    await screen.findByRole("heading", { name: "Edit Price Entry" });
    fireEvent.click(screen.getByRole("button", { name: /^(Save|Update)/ }));

    await waitFor(() => expect(chartUrls()).toHaveLength(2));
  });
});

// Another client (an MCP tool, a second tab, a scheduled job) changes the
// book. The server sends the book socket a hint for each changed table, and
// the page must show the change without a reload.
describe("SecurityDetailPage live updates", () => {
  // BookChangesProvider holds socket hints for 100 ms, then sends one change.
  const AFTER_BATCH_MS = 150;
  const newPrice = { priceDate: "2024-03-08", priceMicros: 260_000_000, source: "Yahoo Finance" };
  const buy = {
    id: 91,
    transactionId: 901,
    transactionDate: "2024-03-05",
    transactionDescription: "Buy VTI",
    accountId: 3,
    accountName: "Brokerage",
    action: "buy",
    sharesMicros: 2_000_000,
    priceMicros: 255_000_000,
    feesCents: 0,
    splitNumerator: null,
    splitDenominator: null,
  };
  let prices: unknown[] = [priceEntry];
  let splitRows: unknown[] = [stockSplit];
  let deleted = false;

  const calls = (prefix: string) =>
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(prefix)).length;
  // The chart asks for limit=5000, so the "&" keeps its requests out.
  const tableCalls = () => calls("/api/b/1/securities/4/prices?limit=50&");

  function hint(tables: string[]) {
    act(() => { FakeWebSocket.instances[FakeWebSocket.instances.length - 1].emit("change", { tables }); });
  }

  async function settle() {
    await act(() => new Promise((resolve) => setTimeout(resolve, AFTER_BATCH_MS)));
  }

  async function renderLive() {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const notFound = { ok: false, status: 404, json: async () => ({ error: "Security not found" }) } as Response;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (deleted) return notFound;
      if (url === "/api/b/1/securities/4/detail") {
        return { ok: true, json: async () => ({ security, positionsByAccount: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/prices?")) {
        return { ok: true, json: async () => ({ prices, totalCount: prices.length }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/splits?")) {
        return { ok: true, json: async () => ({ splits: splitRows, totalCount: splitRows.length }) } as Response;
      }
      if (url === "/api/b/1/securities/4/lots") {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }));
    render(
      <ToastProvider>
        <BookChangesProvider>
          <SecurityDetailPage />
        </BookChangesProvider>
      </ToastProvider>
    );
    await screen.findByRole("heading", { name: "Vanguard Total Stock Market" });
    await screen.findByText("manual");
  }

  beforeEach(() => {
    stubResizeObserver(600);
    prices = [priceEntry];
    splitRows = [stockSplit];
    deleted = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows a price that another client recorded, in the table and the chart", async () => {
    await renderLive();
    const chartBefore = calls(CHART_PREFIX);

    prices = [newPrice, priceEntry];
    hint(["security_prices"]);

    expect(await screen.findByText("Yahoo Finance")).toBeInTheDocument();
    await waitFor(() => expect(calls(CHART_PREFIX)).toBe(chartBefore + 1));
  });

  it("shows a new transaction and keeps the open tab", async () => {
    await renderLive();
    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    await screen.findByText("Split (2-for-1)");

    splitRows = [buy, stockSplit];
    hint(["investment_splits"]);

    expect(await screen.findByText("Buy")).toBeInTheDocument();
    expect(screen.getByText("Split (2-for-1)")).toBeInTheDocument();
    expect(screen.queryByText("manual")).not.toBeInTheDocument();
  });

  it("does not reload for a table that the page does not read", async () => {
    await renderLive();
    const before = vi.mocked(fetch).mock.calls.length;

    hint(["payees", "plaid_accounts"]);
    await settle();

    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it("keeps an open price form, and reloads when it closes", async () => {
    await renderLive();
    fireEvent.click(screen.getByText("manual").closest("tr")!);
    await screen.findByRole("heading", { name: "Edit Price Entry" });
    const price = document.getElementById("price")!;
    fireEvent.change(price, { target: { value: "249.99" } });
    const before = tableCalls();

    prices = [newPrice, priceEntry];
    hint(["security_prices"]);
    await settle();

    expect(tableCalls()).toBe(before);
    expect(price).toHaveValue("249.99");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Yahoo Finance")).toBeInTheDocument();
    expect(tableCalls()).toBe(before + 1);
  });

  it("shows the not-found state when another client deletes the security", async () => {
    await renderLive();

    deleted = true;
    hint(["securities"]);

    expect(await screen.findByText("Security not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Securities/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Vanguard Total Stock Market" })).not.toBeInTheDocument();
  });

  it("keeps the page when a background reload fails", async () => {
    await renderLive();

    vi.mocked(fetch).mockImplementation(async () =>
      ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response
    );
    hint(["securities"]);

    expect(await screen.findByText("Could not refresh security.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vanguard Total Stock Market" })).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
  });
it("ends the first load when a part other than the header fails", async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/securities/4/detail") {
        return { ok: true, json: async () => ({ security, positionsByAccount: [] }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/prices?limit=50&")) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/prices?")) {
        return { ok: true, json: async () => ({ prices: [], totalCount: 0 }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/splits?")) {
        return { ok: true, json: async () => ({ splits: [], totalCount: 0 }) } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }));
    render(<ToastProvider><BookChangesProvider><SecurityDetailPage /></BookChangesProvider></ToastProvider>);

    expect(await screen.findByRole("heading", { name: "Vanguard Total Stock Market" })).toBeInTheDocument();
  });

  it("does not let a load more cancel a live reload of the price list", async () => {
    // 51 prices: the table shows 50, and a load more gets the last one.
    const day = (n: number) => `2024-0${1 + Math.floor(n / 28)}-${String(1 + (n % 28)).padStart(2, "0")}`;
    const older = Array.from({ length: 51 }, (_, n) => ({ priceDate: day(50 - n), priceMicros: 1_000_000, source: "manual" }));
    let rows: unknown[] = older;
    let hold: Promise<void> | null = null;
    let release = () => {};
    let observed: IntersectionObserverCallback | null = null;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observed = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/securities/4/detail") {
        return { ok: true, json: async () => ({ security, positionsByAccount: [] }) } as Response;
      }
      if (url.startsWith(CHART_PREFIX)) {
        return { ok: true, json: async () => ({ prices: [], totalCount: 0 }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/prices?")) {
        const params = new URL(url, "http://localhost").searchParams;
        const offset = Number(params.get("offset"));
        const limit = Number(params.get("limit"));
        const captured = rows;
        if (offset === 0 && hold) await hold;
        return { ok: true, json: async () => ({ prices: captured.slice(offset, offset + limit), totalCount: captured.length }) } as Response;
      }
      if (url.startsWith("/api/b/1/securities/4/splits?")) {
        return { ok: true, json: async () => ({ splits: [], totalCount: 0 }) } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }));
    render(<ToastProvider><BookChangesProvider><SecurityDetailPage /></BookChangesProvider></ToastProvider>);
    await screen.findByRole("heading", { name: "Vanguard Total Stock Market" });
    await waitFor(() => expect(screen.getAllByText("manual")).toHaveLength(50));
    await settle();

    // Another client records a new price. The live reload is in flight when
    // the user scrolls to the end of the list.
    rows = [newPrice, ...older];
    hold = new Promise<void>((resolve) => { release = resolve; });
    hint(["security_prices"]);
    await settle();
    const intersect = observed as IntersectionObserverCallback | null;
    act(() => {
      intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await act(async () => { release(); hold = null; });

    expect(await screen.findByText("Yahoo Finance")).toBeInTheDocument();
    // The reload gave the first 50 rows of the new list: the new price and
    // 49 old prices. No row shows two times.
    const dates = Array.from(document.querySelectorAll("tr")).map((row) => row.textContent ?? "");
    expect(new Set(dates).size).toBe(dates.length);
  });
});
