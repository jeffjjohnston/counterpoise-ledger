import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecuritiesPage from "@/app/b/[bookId]/securities/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

// The page reads the role from the book layout. Each test starts as an owner.
const OWNER_ROLE = { canWrite: true, isOwner: true, role: "owner" };
let bookRoleValue: { canWrite: boolean; isOwner: boolean; role: string } = OWNER_ROLE;

vi.mock("@/components/BookRoleProvider", () => ({
  useBookRole: () => bookRoleValue,
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
    bookRoleValue = OWNER_ROLE;
  });

  it("shows Update Prices and Add Security to an owner", async () => {
    await renderLoadedPage();

    expect(screen.getByRole("button", { name: "Update Prices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Security" })).toBeInTheDocument();
  });

  it("keeps a price typed in the Update prices modal when the page renders again", async () => {
    await renderLoadedPage();
    fireEvent.click(screen.getByRole("button", { name: "Update Prices" }));
    const price = await screen.findByPlaceholderText("0.00");
    fireEvent.change(price, { target: { value: "251.75" } });

    // A page render for any reason: here the search field changes.
    fireEvent.change(screen.getByLabelText("Search securities"), { target: { value: "v" } });

    expect(screen.getByPlaceholderText("0.00")).toHaveValue("251.75");
  });

  it("hides Update Prices and Add Security from a viewer, but keeps Download CSV", async () => {
    // Update Prices writes prices to the book. A viewer cannot write.
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };
    await renderLoadedPage();

    expect(screen.queryByRole("button", { name: "Update Prices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Security" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
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

  it("draws the market value of each priced security, and follows the search", async () => {
    stubResizeObserver(600);
    await renderLoadedPage();

    // ACME has no price, so it has no bar.
    expect(
      screen.getByRole("img", {
        name: "Market value by security, largest VMFXX at $2,500.00 (89.3%), all $2,800.00",
      })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search securities"), {
      target: { value: "vanguard total" },
    });
    // One security is left. One bar has no allocation to show.
    expect(screen.queryByRole("button", { name: "Hide chart" })).not.toBeInTheDocument();
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

  // Another client (an MCP tool, a second tab, a scheduled job) changes the
  // book. The server sends the book socket a hint for each changed table, and
  // the page must show the change without a reload.
  describe("live updates", () => {
    // BookChangesProvider holds socket hints for 100 ms, then sends one change.
    const AFTER_BATCH_MS = 150;
    let rows: unknown[] = securitiesFixture;
    const listCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/b/1/securities").length;

    function hint(tables: string[]) {
      act(() => { FakeWebSocket.instances[FakeWebSocket.instances.length - 1].emit("change", { tables }); });
    }

    async function settle() {
      await act(() => new Promise((resolve) => setTimeout(resolve, AFTER_BATCH_MS)));
    }

    async function renderLive() {
      rows = securitiesFixture;
      FakeWebSocket.instances = [];
      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/b/1/securities") {
          return { ok: true, status: 200, json: async () => rows } as Response;
        }
        throw new Error(`Unexpected fetch url: ${url}`);
      }));
      render(
        <ToastProvider>
          <BookChangesProvider>
            <SecuritiesPage />
          </BookChangesProvider>
        </ToastProvider>
      );
      await screen.findByText("Vanguard Total Stock Market");
    }

    afterEach(() => { vi.unstubAllGlobals(); });

    it("shows a price that another client recorded", async () => {
      await renderLive();
      expect(screen.getByText("$300.00")).toBeInTheDocument();

      rows = securitiesFixture.map((row) =>
        row.id === 1 ? { ...row, priceMicros: 31_000_000, marketValueCents: 31000 } : row
      );
      hint(["security_prices"]);

      expect(await screen.findByText("$310.00")).toBeInTheDocument();
    });

    it("does not reload for a table that the list does not read", async () => {
      await renderLive();
      const before = listCalls();

      hint(["payees", "recurring_rules"]);
      await settle();

      expect(listCalls()).toBe(before);
    });

    it("keeps an open edit form, and reloads when it closes", async () => {
      await renderLive();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const name = await screen.findByLabelText("Security Name");
      fireEvent.change(name, { target: { value: "Acme draft" } });
      const before = listCalls();

      rows = securitiesFixture.map((row) => (row.id === 2 ? { ...row, name: "Acme Renamed" } : row));
      hint(["securities"]);
      await settle();

      expect(listCalls()).toBe(before);
      expect(screen.getByLabelText("Security Name")).toHaveValue("Acme draft");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(await screen.findByText("Acme Renamed")).toBeInTheDocument();
      expect(listCalls()).toBe(before + 1);
    });

    it("keeps the list and the search when a background reload fails", async () => {
      await renderLive();
      fireEvent.change(screen.getByLabelText("Search securities"), { target: { value: "vti" } });

      vi.mocked(fetch).mockImplementation(async () =>
        ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response
      );
      hint(["securities"]);

      expect(await screen.findByText("Could not refresh securities.")).toBeInTheDocument();
      expect(screen.getByText("Vanguard Total Stock Market")).toBeInTheDocument();
      expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Search securities")).toHaveValue("vti");
    });
  });
});
