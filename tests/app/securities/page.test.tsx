import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecuritiesPage from "@/app/b/[bookId]/securities/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const securitiesFixture = [
  {
    id: 1,
    name: "Vanguard Total Stock Market",
    symbol: "VTI",
    securityType: "etf",
    fetchPrices: true,
    fixedPriceMicros: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    sharesMicros: 10_000_000,
    costBasisCents: 10000,
    priceMicros: 30_000_000,
    priceDate: "2024-01-10",
    marketValueCents: 30000,
    incomeCents: 0,
  },
  {
    id: 2,
    name: "Acme Corp",
    symbol: "ACME",
    securityType: "stock",
    fetchPrices: true,
    fixedPriceMicros: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    sharesMicros: 0,
    costBasisCents: 0,
    priceMicros: null,
    priceDate: null,
    marketValueCents: null,
    incomeCents: 0,
  },
  {
    id: 3,
    name: "Vanguard Federal Money Market",
    symbol: "VMFXX",
    securityType: "mutual_fund",
    fetchPrices: false,
    fixedPriceMicros: 1_000_000,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    sharesMicros: 2_500_000_000,
    costBasisCents: 250_000,
    priceMicros: 1_000_000,
    priceDate: "2024-01-10",
    marketValueCents: 250_000,
    incomeCents: 0,
  },
];

function stubFetch() {
  // Typed by signature rather than by parameter list: the tests read the
  // RequestInit of the POST call, but the stub itself never needs it.
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/securities")) {
        return {
          ok: true,
          json: async () => securitiesFixture,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    }
  );

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderLoadedPage() {
  stubFetch();
  render(<SecuritiesPage />);

  await waitFor(() => {
    expect(screen.getByText("Vanguard Total Stock Market")).toBeInTheDocument();
  });
}

describe("SecuritiesPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links each security row to the detail page", async () => {
    await renderLoadedPage();

    expect(screen.getByRole("link", { name: /Vanguard Total Stock Market/i })).toHaveAttribute(
      "href",
      "/b/1/securities/1"
    );
    expect(screen.getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
      "href",
      "/b/1/securities/2"
    );
  });

  it("filters securities by name across active and inactive lists", async () => {
    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Search securities"), {
      target: { value: "acme" },
    });

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.queryByText("Vanguard Total Stock Market")).not.toBeInTheDocument();
  });

  it("filters securities by symbol, case-insensitively", async () => {
    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Search securities"), {
      target: { value: "vTi" },
    });

    expect(screen.getByText("Vanguard Total Stock Market")).toBeInTheDocument();
    expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
  });

  it("shows a message when no securities match the search", async () => {
    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Search securities"), {
      target: { value: "nothing matches this" },
    });

    expect(screen.getByText("No securities match your search.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("security-row")).toHaveLength(0);
  });

  it("marks a fixed-price security in the list", async () => {
    // Its price never changes, so without a marker the row reads as a stale
    // price nobody has updated.
    await renderLoadedPage();

    const row = screen
      .getByText("Vanguard Federal Money Market")
      .closest("[data-testid='security-row']");

    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("fixed");
  });

  it("sends the fixed price when creating a security", async () => {
    const fetchMock = stubFetch();
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText("Vanguard Total Stock Market")).toBeInTheDocument();
    });

    // The page's trigger and the form's submit share this label, so the modal
    // has to be opened by the first one and submitted by the last.
    fireEvent.click(screen.getAllByRole("button", { name: "Add Security" })[0]);
    fireEvent.change(screen.getByLabelText("Security Name"), {
      target: { value: "Fidelity Government MMF" },
    });
    fireEvent.change(screen.getByLabelText("Symbol"), {
      target: { value: "SPAXX" },
    });
    fireEvent.click(screen.getByLabelText("Fixed price"));
    fireEvent.change(screen.getByLabelText("Price"), {
      target: { value: "1.00" },
    });
    const submitButtons = screen.getAllByRole("button", { name: "Add Security" });
    fireEvent.click(submitButtons[submitButtons.length - 1]);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post![1]!.body as string)).toMatchObject({
        symbol: "SPAXX",
        fixedPriceMicros: 1_000_000,
      });
    });
  });
});
