import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SecurityDetailPage from "@/app/b/[bookId]/securities/[id]/page";

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

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/securities/4/detail") {
        return { ok: true, json: async () => ({ security, positionsByAccount: [] }) } as Response;
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
  afterEach(() => {
    vi.unstubAllGlobals();
    bookRoleValue = OWNER_ROLE;
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
