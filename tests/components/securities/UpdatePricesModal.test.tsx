import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UpdatePricesModal } from "@/components/securities/UpdatePricesModal";
import { ToastProvider } from "@/components/ui/ToastProvider";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/securities",
}));

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

const securities = [
  {
    id: 1,
    name: "Vanguard Total Stock Market",
    symbol: "VTI",
    sharesMicros: 1_000_000,
    priceMicros: 250_000_000,
    priceDate: "2024-01-01",
    fetchPrices: false,
    fixedPriceMicros: null,
  },
  {
    id: 2,
    name: "Apple Inc.",
    symbol: "AAPL",
    sharesMicros: 500_000,
    priceMicros: null,
    priceDate: null,
    fetchPrices: true,
    fixedPriceMicros: null,
  },
];

// fetchPrices is deliberately left on: a fixed price must be what excludes
// this security from the Tiingo call, not a flag that happens to agree.
const fixedPriceSecurity = {
  id: 3,
  name: "Vanguard Federal Money Market",
  symbol: "VMFXX",
  sharesMicros: 2_500_000_000,
  priceMicros: 1_000_000,
  priceDate: "2024-01-01",
  fetchPrices: true,
  fixedPriceMicros: 1_000_000,
};

describe("UpdatePricesModal", () => {
  let originalFetch: typeof global.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    global.fetch = fetchMock as typeof global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // @ts-expect-error - test cleanup for environments without fetch
      delete global.fetch;
    }
    // Always restore real timers, even if an assertion failed mid-test.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("initializes fetch selections from security preferences", async () => {
    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it("defaults date to previous trading day before market open", async () => {
    // Wednesday 7:00 AM ET → before 9:30 AM, so default to Tuesday
    vi.useFakeTimers({ toFake: ["Date"] });
    // Set to Wednesday April 8, 2026 at 11:00 UTC = 7:00 AM ET (EDT)
    vi.setSystemTime(new Date("2026-04-08T11:00:00Z"));

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    const dateInputs = screen.getAllByDisplayValue("2026-04-07");
    expect(dateInputs.length).toBeGreaterThan(0);
  });

  it("defaults date to today after market open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Set to Wednesday April 8, 2026 at 14:00 UTC = 10:00 AM ET (EDT)
    vi.setSystemTime(new Date("2026-04-08T14:00:00Z"));

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    const dateInputs = screen.getAllByDisplayValue("2026-04-08");
    expect(dateInputs.length).toBeGreaterThan(0);
  });

  it("defaults to Friday when before market open on Monday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Monday April 6, 2026 at 11:00 UTC = 7:00 AM ET (EDT)
    vi.setSystemTime(new Date("2026-04-06T11:00:00Z"));

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    // Before market open on Monday → Sunday → skip weekend → Friday April 3
    const dateInputs = screen.getAllByDisplayValue("2026-04-03");
    expect(dateInputs.length).toBeGreaterThan(0);
  });

  it("persists fetch selections via the API", async () => {
    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes[1]).toBeChecked();

    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/b/1/securities/2");
    expect(options).toMatchObject({ method: "PUT" });
    // apiFetch normalizes headers through the Headers constructor (see
    // lib/api-client.ts), not a plain object — toMatchObject can't see into
    // it, since Headers stores entries in an internal slot rather than as
    // own enumerable properties.
    expect((options.headers as Headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(options.body as string)).toEqual({ fetchPrices: false });
  });

  it("alerts and stays open when an entered price cannot be parsed", async () => {
    const onClose = vi.fn();

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={onClose}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    const priceInputs = await screen.findAllByPlaceholderText("0.00");
    fireEvent.change(priceInputs[0], { target: { value: "1+" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "These prices are not valid numbers and were not saved:",
        { exact: false }
      )
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/security-prices/bulk")
      )
    ).toBe(false);
  });

  it("saves nothing when one entered price is invalid alongside valid ones", async () => {
    const onClose = vi.fn();
    const onUpdate = vi.fn();

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={onClose}
        securities={securities}
        onUpdate={onUpdate}
      />
    );

    const priceInputs = await screen.findAllByPlaceholderText("0.00");
    fireEvent.change(priceInputs[0], { target: { value: "260.00" } });
    fireEvent.change(priceInputs[1], { target: { value: "1+" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "These prices are not valid numbers and were not saved:",
        { exact: false }
      )
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/security-prices/bulk")
      )
    ).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders a fixed-price security read-only, with no fetch checkbox", async () => {
    // Its price is a property of the security, changed on the security itself —
    // not something to type a new value for here.
    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={[...securities, fixedPriceSecurity]}
        onUpdate={vi.fn()}
      />
    );

    const row = (await screen.findByText("Vanguard Federal Money Market")).closest("tr")!;

    expect(row).toHaveTextContent("Fixed");
    expect(row.querySelector("input")).toBeNull();
  });

  it("does not ask Tiingo for a fixed-price security", async () => {
    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={[securities[1], fixedPriceSecurity]}
        onUpdate={vi.fn()}
      />
    );

    // The shared stub answers every call with {}; the Tiingo route's real shape
    // is {prices, errors}, and the component reads both.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: [], errors: [] }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Retrieve Latest Prices/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/security-prices/tiingo")
      );
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string).symbols).toEqual([
        "AAPL",
      ]);
    });
  });

  it("reports an unusable price-service response instead of crashing", async () => {
    // The component reads `prices` inside a setState updater, which React runs
    // outside the try/catch around the fetch. A response the component cannot
    // use therefore escapes the error handling written for it and takes the
    // whole modal down; it has to reach the user as a message like any other
    // failed request.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    renderWithToast(
      <UpdatePricesModal
        isOpen
        onClose={vi.fn()}
        securities={securities}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Retrieve Latest Prices/i }));

    expect(await screen.findByText("Failed to fetch prices", { exact: false })).toBeInTheDocument();
  });
});
