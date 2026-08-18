import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/hooks/useRegisterShortcuts", () => ({
  useRegisterShortcuts: vi.fn(),
}));

import { PriceEntryPill } from "@/components/layout/PriceEntryPill";
import { PRICES_SAVED_EVENT } from "@/lib/events";
import { useRegisterShortcuts } from "@/hooks/useRegisterShortcuts";
import type { ShortcutDef } from "@/components/KeyboardShortcutProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

const DUE_PAYLOAD = {
  dueDate: "2026-07-02",
  securities: [
    {
      securityId: 5,
      name: "SPY Jul '26 630C",
      symbol: "SPY260731C630",
      lastPriceMicros: 4_350_000,
      lastPriceDate: "2026-07-01",
    },
    {
      securityId: 6,
      name: "SPY Jul '26 560P",
      symbol: "SPY260731P560",
      lastPriceMicros: null,
      lastPriceDate: null,
    },
  ],
};

function mockFetch(duePayload: unknown | (() => unknown)) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/securities/prices-due")) {
      const payload =
        typeof duePayload === "function" ? (duePayload as () => unknown)() : duePayload;
      return { ok: true, json: async () => payload } as Response;
    }
    if (href.includes("/security-prices/bulk") && init?.method === "POST") {
      return { ok: true, json: async () => ({ count: 2 }) } as Response;
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("PriceEntryPill", () => {
  it("renders nothing at all when no securities are due", async () => {
    const fetchFn = mockFetch({ dueDate: "2026-07-02", securities: [] });
    // Deliberately unwrapped: ToastProvider's own stack container would make
    // container.firstChild non-null regardless of what PriceEntryPill itself
    // renders, defeating the point of this assertion.
    const { container } = render(<PriceEntryPill bookId="1" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    // Not even an empty wrapper: a phantom flex item would still take up a
    // gap slot in the navbar
    expect(container.firstChild).toBeNull();
  });

  it("shows a pill with the due count", async () => {
    mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    expect(await screen.findByRole("button", { name: /2 prices due/ })).toBeInTheDocument();
  });

  it("uses singular copy for one due security", async () => {
    mockFetch({ ...DUE_PAYLOAD, securities: DUE_PAYLOAD.securities.slice(0, 1) });
    renderWithToast(<PriceEntryPill bookId="1" />);
    expect(await screen.findByRole("button", { name: /1 price due/ })).toBeInTheDocument();
  });

  it("re-checks when the tab becomes visible again", async () => {
    // Tab open before the early-morning price sync: nothing due yet
    let payload: unknown = { dueDate: "2026-07-01", securities: [] };
    const fetchFn = mockFetch(() => payload);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    // Cron advances the due date while the tab sits in the background
    payload = DUE_PAYLOAD;
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: /2 prices due/ })).toBeInTheDocument();
  });

  it("re-checks when the window regains focus", async () => {
    let payload: unknown = { dueDate: "2026-07-01", securities: [] };
    const fetchFn = mockFetch(() => payload);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    payload = DUE_PAYLOAD;
    fireEvent(window, new Event("focus"));

    expect(await screen.findByRole("button", { name: /2 prices due/ })).toBeInTheDocument();
  });

  it("hides the pill when a re-check finds nothing due", async () => {
    let payload: unknown = DUE_PAYLOAD;
    mockFetch(() => payload);
    renderWithToast(<PriceEntryPill bookId="1" />);
    expect(await screen.findByRole("button", { name: /2 prices due/ })).toBeInTheDocument();

    // Prices were entered elsewhere (another tab/device) while this tab was hidden
    payload = { dueDate: "2026-07-02", securities: [] };
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("does not reopen the popover when securities become due again after a clearing re-check", async () => {
    let payload: unknown = DUE_PAYLOAD;
    mockFetch(() => payload);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    // Prices entered in another tab while the popover sits open here
    payload = { dueDate: "2026-07-02", securities: [] };
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Next market day: the pill returns, but the popover must wait to be asked
    payload = { ...DUE_PAYLOAD, dueDate: "2026-07-03" };
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: /2 prices due/ });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the pill when a re-check fails", async () => {
    let fail = false;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/securities/prices-due")) {
        if (fail) return { ok: false, json: async () => ({}) } as Response;
        return { ok: true, json: async () => DUE_PAYLOAD } as Response;
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchFn);
    renderWithToast(<PriceEntryPill bookId="1" />);
    expect(await screen.findByRole("button", { name: /2 prices due/ })).toBeInTheDocument();

    // A transient server error is not evidence that nothing is due
    fail = true;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /2 prices due/ })).toBeInTheDocument();
  });

  async function openPopover() {
    fireEvent.click(await screen.findByRole("button", { name: /prices? due/ }));
    return await screen.findByRole("dialog");
  }

  it("opens the popover with symbols and prefilled last marks", async () => {
    mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    expect(screen.getByText("Prices due · Jul 2")).toBeInTheDocument();
    expect(screen.getByText("SPY260731C630")).toBeInTheDocument();
    expect(screen.getByText("SPY260731P560")).toBeInTheDocument();

    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue("4.35");
    expect(inputs[1]).toHaveValue("");
  });

  it("focuses and selects the first input when opened", async () => {
    mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    await waitFor(() => {
      const first = screen.getAllByRole("textbox")[0] as HTMLInputElement;
      expect(document.activeElement).toBe(first);
      expect(first.selectionStart).toBe(0);
      expect(first.selectionEnd).toBe("4.35".length);
    });
  });

  it("closes on Escape and on outside click, keeping typed values", async () => {
    mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "9.99" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await openPopover();
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("9.99");

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves entered prices, closes, dispatches the saved event, and shows a toast", async () => {
    const fetchFn = mockFetch(DUE_PAYLOAD);
    const savedListener = vi.fn();
    window.addEventListener(PRICES_SAVED_EVENT, savedListener);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "4.50" } });
    fireEvent.change(inputs[1], { target: { value: "2.10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(savedListener).toHaveBeenCalledTimes(1));
    window.removeEventListener(PRICES_SAVED_EVENT, savedListener);

    const bulkCall = fetchFn.mock.calls.find(([url]) =>
      String(url).includes("/security-prices/bulk")
    );
    expect(bulkCall).toBeDefined();
    expect(String(bulkCall![0])).toBe("/api/b/1/security-prices/bulk");
    expect(JSON.parse(bulkCall![1]!.body as string)).toEqual({
      priceUpdates: [
        { securityId: 5, priceMicros: 4_500_000, priceDate: "2026-07-02" },
        { securityId: 6, priceMicros: 2_100_000, priceDate: "2026-07-02" },
      ],
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /prices? due/ })).not.toBeInTheDocument();
    expect(screen.getByText("2 prices saved")).toBeInTheDocument();
  });

  it("saves when Enter is pressed in a price field", async () => {
    const fetchFn = mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[1], { target: { value: "2.10" } });
    fireEvent.keyDown(inputs[1], { key: "Enter" });

    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(([url]) => String(url).includes("/security-prices/bulk"))
      ).toBe(true)
    );
  });

  it("disables Save while a due security has no valid price", async () => {
    const fetchFn = mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    // Second security never priced
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(screen.getAllByRole("textbox")[0], { key: "Enter" });
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(([url]) => String(url).includes("/security-prices/bulk"))
      ).toBe(false)
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the popover open with values intact when the save fails", async () => {
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/securities/prices-due")) {
        return { ok: true, json: async () => DUE_PAYLOAD } as Response;
      }
      if (href.includes("/security-prices/bulk") && init?.method === "POST") {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fn);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "4.50" } });
    fireEvent.change(inputs[1], { target: { value: "2.10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled()
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("4.50");
    expect(screen.getAllByRole("textbox")[1]).toHaveValue("2.10");
    // The popover staying open and the toast firing must both hold — either
    // could regress independently, and only this pins the second.
    expect(await screen.findByText("Request failed (500)")).toBeInTheDocument();
  });

  it("preserves typed values when a re-check refreshes the list", async () => {
    let payload: unknown = DUE_PAYLOAD;
    mockFetch(() => payload);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await openPopover();

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "9.99" } });

    // The re-check returns an additional security; its input appearing proves
    // the refresh rendered before we assert against the current DOM
    payload = {
      ...DUE_PAYLOAD,
      securities: [
        ...DUE_PAYLOAD.securities,
        {
          securityId: 7,
          name: "SPY Aug '26 650C",
          symbol: "SPY260831C650",
          lastPriceMicros: 1_230_000,
          lastPriceDate: "2026-07-01",
        },
      ],
    };
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(3));
    const refreshed = screen.getAllByRole("textbox");
    expect(refreshed[0]).toHaveValue("9.99"); // typed value survives the refresh
    expect(refreshed[2]).toHaveValue("1.23"); // new security prefills from its last mark
  });

  it("ignores an out-of-order response from an earlier check", async () => {
    // Deferred fetch: each prices-due call resolves only when we say so
    const pending: Array<(payload: unknown) => void> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes("/securities/prices-due")) {
        throw new Error(`Unexpected fetch: ${String(url)}`);
      }
      return new Promise((resolve) => {
        pending.push((payload: unknown) =>
          resolve({ ok: true, json: async () => payload } as Response)
        );
      });
    });
    vi.stubGlobal("fetch", fetchFn);

    renderWithToast(<PriceEntryPill bookId="1" />);
    await waitFor(() => expect(pending).toHaveLength(1));

    // Tab-return burst: focus and visibilitychange both fire while the
    // initial request is still in flight
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(pending).toHaveLength(2));

    // The later request resolves first, with newer data
    pending[1]({ ...DUE_PAYLOAD, dueDate: "2026-07-03" });
    await screen.findByRole("button", { name: /2 prices due/ });

    // The earlier request resolves last, with older data — must be ignored.
    // Flush its continuations fully before asserting, so a stale apply
    // cannot land after the assertion.
    await act(async () => {
      pending[0]({ ...DUE_PAYLOAD, dueDate: "2026-07-02" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await openPopover();
    expect(screen.getByText("Prices due · Jul 3")).toBeInTheDocument();
    expect(screen.queryByText("Prices due · Jul 2")).not.toBeInTheDocument();
  });

  it("registers the P shortcut whose action opens the popover", async () => {
    mockFetch(DUE_PAYLOAD);
    renderWithToast(<PriceEntryPill bookId="1" />);
    await screen.findByRole("button", { name: /2 prices due/ });

    const mocked = vi.mocked(useRegisterShortcuts);
    const calls = mocked.mock.calls.map(([defs]) => defs as ShortcutDef[]);
    const withShortcut = calls.filter((defs) => defs.length > 0).at(-1);
    expect(withShortcut).toBeDefined();
    expect(withShortcut![0]).toMatchObject({
      id: "price-entry",
      keys: ["p"],
      description: "Enter security prices",
    });

    act(() => withShortcut![0].action());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
