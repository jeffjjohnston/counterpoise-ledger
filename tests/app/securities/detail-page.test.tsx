import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecurityDetailPage from "@/app/b/[bookId]/securities/[id]/page";
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
