import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookChangesProvider, useBookChanges } from "@/components/BookChangesProvider";
import { useTransactionsPageData } from "@/app/b/[bookId]/transactions/useTransactionsPageData";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

const notified = vi.fn();
const scroll = vi.fn(); const toast = { error: vi.fn() }; const router = { replace: vi.fn() };
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }), useRouter: () => router,
  })
);
// The unstable-callback cases set this to 0. From then on it counts renders of
// the hook, and each render below RENDER_CAP gets a new toast object, as an
// unmemoized provider gives. The cap stops the loop if the hook regresses, so
// the test fails and does not run out of memory.
const RENDER_CAP = 40;
let unstableRenders = -1;
const isUnstable = () => unstableRenders >= 0 && unstableRenders < RENDER_CAP;
vi.mock("@/components/ui/ToastProvider", () => ({ useToast: () => {
  if (unstableRenders < 0) return toast;
  unstableRenders++;
  return isUnstable() ? { ...toast } : toast;
} }));
let version = 1;
let hold: Promise<void> | undefined;
let getCount = 0;
let failPath: string | undefined;
// Requests to a path with this ending wait until `releasePanel` runs.
let holdPath: string | undefined;
let releasePanel: () => void = () => {};
const requests: string[] = [];
function Fixture() {
  useBookChanges(notified);
  const [paused, setPaused] = useState(false);
  const [account, setAccount] = useState(1);
  const ensureIdRef = useRef<number | null>(null);
  const data = useTransactionsPageData({ bookId: "1", accountId: account, startDate: "", endDate: "",
    selectedPayeeId: null, showUpcoming: true, scrollTransactionsToTop: scroll, ensureIdRef, deferBackgroundRefresh: paused });
  return <>
    <output aria-label="register">{data.transactions[0]?.description}</output>
    <output aria-label="projected">{data.projectedTransactions[0]?.description}</output>
    <output aria-label="pending">{data.plaidPendingTransactions[0]?.description}</output>
    <output aria-label="rows">{data.transactions.length}</output>
    <output aria-label="positions">{data.positionsVersion}</output>
    <output aria-label="error">{data.error}</output>
    <button onClick={() => { void data.refreshData(false, 99); }}>Local refresh</button>
    <output aria-label="loading">{String(data.loading)}</output>
    <button onClick={() => setPaused(!paused)}>{paused ? "Close editor" : "Edit"}</button>
    {paused && <input aria-label="Draft" defaultValue="keep this" />}
    <button onClick={() => setAccount(2)}>Other account</button>
    <button onClick={() => { void data.fetchTransactionsPage(data.transactions.length, true, {
      selectedAccountId: account, isInvestmentAccount: false, investmentCashAccountId: null,
      startDate: "", endDate: "", selectedPayeeId: null,
    }); }}>Load more</button>
  </>;
}
function source() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
async function change(table = "transactions") {
  act(() => { source().emit("change", { tables: [table] }); });
  // The caller moves the fake clock through the windows below.
}
// These values come from the source. If the source changes one, change it here.
// BookChangesProvider holds socket hints for 100 ms, then sends one change.
const BATCH_MS = 100;
// useTransactionsPageData (REFRESH_COALESCE_MS) waits 400 ms before a snapshot
// that is not immediate.
const COALESCE_MS = 400;
// A change hint starts a background snapshot after the two windows.
const HINT_TO_FETCH_MS = BATCH_MS + COALESCE_MS;
// The fake clock runs requestAnimationFrame callbacks on 16 ms frames.
const FRAME_MS = 16;
/** Move the fake clock and let React apply the results. Use with vi.useFakeTimers(). */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => {
  unstableRenders = -1;
  version = 1; hold = undefined; failPath = undefined; holdPath = undefined; toast.error.mockClear(); getCount = 0; requests.length = 0; scroll.mockClear(); notified.mockClear();
  FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "http://localhost");
    if (url.pathname.endsWith(failPath ?? "never-matches")) throw new Error("Injected endpoint failure");
    if (url.pathname.endsWith(holdPath ?? "never-matches")) await new Promise<void>((release) => { releasePanel = release; });
    const captured = version;
    let data: unknown = [];
    if (url.pathname.endsWith("/accounts")) data = [1, 2].map((id) => ({ id, name: `Account ${id}`, type: "asset", subtype: "bank", isActive: true, children: [] }));
    if (url.pathname.endsWith("/transactions")) {
      getCount++;
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      data = { transactions: Array.from({ length: limit }, (_, i) => ({ id: i + offset + 1, description: `v${captured}-account${url.searchParams.get("accountId")}`, splits: [], date: "2026-09-20" })), totalCount: 200, startingBalance: 0 };
      if (hold) await hold;
    }
    if (url.pathname.endsWith("/recurring/projected") || url.pathname.endsWith("/sync/pending-transactions")) data = [{ description: `v${captured}` }];
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("transaction live refresh", () => {
  it("updates all projections and retains loaded extent without scrolling", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    fireEvent.click(screen.getByText("Load more"));
    await advance(FRAME_MS);
    expect(screen.getByLabelText("rows")).toHaveTextContent("100");
    expect(scroll).toHaveBeenCalled();
    scroll.mockClear(); version = 2; await change("books");
    // One more frame, so that a scroll request from the refresh has time to run.
    await advance(HINT_TO_FETCH_MS + FRAME_MS);
    expect(screen.getByLabelText("register")).toHaveTextContent("v2-account1");
    expect(screen.getByLabelText("projected")).toHaveTextContent("v2");
    expect(screen.getByLabelText("pending")).toHaveTextContent("v2");
    expect(screen.getByLabelText("rows")).toHaveTextContent("100");
    expect(screen.getByLabelText("positions")).toHaveTextContent("2");
    expect(scroll).not.toHaveBeenCalled();
  });

  // The page needs the account list before the transaction request (for the
  // cash account of an investment account). It needs no other panel first.
  it("asks for the transactions while a slow optional panel is still loading", async () => {
    vi.useFakeTimers();
    holdPath = "/payees";
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await advance(0);
    expect(requests.some((request) => request.includes("/api/b/1/transactions?"))).toBe(true);
    // The snapshot is still published whole: nothing shows before the panel.
    expect(screen.getByLabelText("rows")).toHaveTextContent("0");
    releasePanel();
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
  });

  it("defers during editing and runs a trailing refresh for an event during a fetch", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unsaved draft" } });
    // Wait past the time at which a refresh would start if the editor did not defer it.
    version = 2; await change();
    await advance(HINT_TO_FETCH_MS);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(getCount).toBe(1);
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved draft");
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(screen.getByText("Close editor"));
    await advance(COALESCE_MS);
    expect(getCount).toBe(2);
    version = 3; await change();
    await advance(HINT_TO_FETCH_MS);
    expect(notified).toHaveBeenCalledTimes(2);
    expect(getCount).toBe(2);
    hold = undefined; await act(async () => release());
    await advance(COALESCE_MS);
    expect(screen.getByLabelText("register")).toHaveTextContent("v3-account1");
    expect(getCount).toBe(3);
  });

  it("discards an old account response even when transport ignores abort", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    version = 2; await change();
    await advance(HINT_TO_FETCH_MS);
    expect(getCount).toBe(2);
    hold = undefined; version = 3;
    fireEvent.click(screen.getByText("Other account"));
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v3-account2");
    await act(async () => release());
    expect(screen.getByLabelText("register")).toHaveTextContent("v3-account2");
  });

  it("discards a background snapshot if editing starts in flight and reloads on close", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    version = 2;
    await change();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getCount).toBe(2);

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unsaved draft" } });
    hold = undefined;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });

    // No part of the discarded snapshot may publish while the draft is open.
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    expect(screen.getByLabelText("projected")).toHaveTextContent("v1");
    expect(screen.getByLabelText("pending")).toHaveTextContent("v1");
    expect(screen.getByLabelText("positions")).toHaveTextContent("1");
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved draft");

    version = 3;
    fireEvent.click(screen.getByText("Close editor"));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByLabelText("register")).toHaveTextContent("v3-account1");
    expect(screen.getByLabelText("projected")).toHaveTextContent("v3");
    expect(screen.getByLabelText("pending")).toHaveTextContent("v3");
    expect(screen.getByLabelText("positions")).toHaveTextContent("2");
    expect(getCount).toBe(3);
  });

  it("finishes initial loading under StrictMode", async () => {
    render(<StrictMode><BookChangesProvider><Fixture /></BookChangesProvider></StrictMode>);
    await screen.findByText("v1-account1");
    expect(screen.getByLabelText("loading")).toHaveTextContent("false");
  });
});


describe("review regressions", () => {
  it.each(["/investments/account-values", "/payees", "/recurring/projected", "/sync/pending-transactions"])(
    "loads and refreshes core rows when %s fails", async (path) => {
      vi.useFakeTimers();
      failPath = path;
      render(<BookChangesProvider><Fixture /></BookChangesProvider>);
      await advance(0);
      expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
      expect(screen.getByLabelText("error")).toBeEmptyDOMElement();
      version = 2; await change();
      await advance(HINT_TO_FETCH_MS);
      expect(screen.getByLabelText("register")).toHaveTextContent("v2-account1");
      expect(screen.getByLabelText("positions")).toHaveTextContent("2");
      expect(toast.error).not.toHaveBeenCalled();
    });

  it.each(["/investments/account-values", "/payees", "/recurring/projected", "/sync/pending-transactions"])(
    "keeps refreshing core rows if %s becomes unavailable", async (path) => {
      vi.useFakeTimers();
      render(<BookChangesProvider><Fixture /></BookChangesProvider>);
      await advance(0);
      expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
      failPath = path; version = 2;
      await change();
      await advance(HINT_TO_FETCH_MS);
      expect(screen.getByLabelText("register")).toHaveTextContent("v2-account1");
      expect(screen.getByLabelText("error")).toBeEmptyDOMElement();
      expect(toast.error).not.toHaveBeenCalled();
    });

  it("keeps rendered rows and reports a core refresh failure", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    failPath = "/transactions"; version = 2;
    await change();
    await advance(HINT_TO_FETCH_MS);
    expect(toast.error).toHaveBeenCalledWith("Could not refresh transactions.");
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    expect(screen.getByLabelText("error")).toBeEmptyDOMElement();
  });

  it.each(["/accounts", "/transactions"])("shows an initial error under StrictMode when %s fails", async (path) => {
    failPath = path;
    render(<StrictMode><BookChangesProvider><Fixture /></BookChangesProvider></StrictMode>);
    await waitFor(() => expect(screen.getByLabelText("loading")).toHaveTextContent("false"));
    expect(screen.getByLabelText("error")).toHaveTextContent("Could not load transactions.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(["explicit-first", "notification-first"])("coalesces a local write and its echo (%s)", async (order) => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getCount).toBe(1);
    version = 2;
    if (order === "explicit-first") {
      fireEvent.click(screen.getByText("Local refresh"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await change();
    } else {
      await change();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      fireEvent.click(screen.getByText("Local refresh"));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getCount).toBe(2);
    expect(requests.filter((url) => url.includes("/accounts?"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("/recurring/projected"))).toHaveLength(2);
    expect(screen.getByLabelText("register")).toHaveTextContent("v2-account1");
    expect(requests.findLast((url) => url.includes("/transactions?"))).toContain("ensureId=99");
  });

  it("retains a distinct external change received during an explicit refresh", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });
    version = 2;
    fireEvent.click(screen.getByText("Local refresh"));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getCount).toBe(2);
    version = 3; await change();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(getCount).toBe(2);
    hold = undefined;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(1000); });
    expect(getCount).toBe(3);
    expect(screen.getByLabelText("register")).toHaveTextContent("v3-account1");
  });

  it("runs the explicit refresh even without a notification and cancels queued work on navigation", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<BookChangesProvider><Fixture /></BookChangesProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    version = 2;
    fireEvent.click(screen.getByText("Local refresh"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByLabelText("register")).toHaveTextContent("v2-account1");
    fireEvent.click(screen.getByText("Local refresh"));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getCount).toBe(2);
  });
});

// A caller can pass callbacks with a new identity on each render. The hook must
// not treat a new identity as a new filter. Each new identity used to start a
// new scope and a new fetch, which rendered again, without end.
describe("unstable callbacks", () => {
  function UnstableFixture() {
    const ensureIdRef = useRef<number | null>(null);
    const data = useTransactionsPageData({ bookId: "1", accountId: 1, startDate: "", endDate: "",
      selectedPayeeId: null, showUpcoming: false,
      scrollTransactionsToTop: isUnstable() ? () => scroll() : scroll, ensureIdRef });
    return <output aria-label="register">{data.transactions[0]?.description}</output>;
  }

  beforeEach(() => { unstableRenders = 0; });

  it("fetches once for a new scroll callback and toast on each render", async () => {
    vi.useFakeTimers();
    render(<BookChangesProvider><UnstableFixture /></BookChangesProvider>);
    await advance(0);
    expect(screen.getByLabelText("register")).toHaveTextContent("v1-account1");
    // Give a render loop time to start. The render cap stops a loop that starts.
    await advance(100);
    expect(unstableRenders).toBeLessThan(RENDER_CAP);
    expect(getCount).toBe(1);
  });

  it("calls the latest scroll callback after the first load", async () => {
    render(<BookChangesProvider><UnstableFixture /></BookChangesProvider>);
    await screen.findByText("v1-account1");
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });
});
