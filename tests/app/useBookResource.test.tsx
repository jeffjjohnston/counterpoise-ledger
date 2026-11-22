import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBookResource } from "@/hooks/useBookResource";

const toast = { error: vi.fn() };
vi.mock("@/components/ui/ToastProvider", () => ({ useToast: () => toast }));

// The live reload has its own tests. Here the mock keeps what the hook gave
// it, so a test can send a change by hand.
const live = vi.hoisted(() => ({ tables: [] as string[], reload: () => {}, paused: false }));
vi.mock("@/components/BookChangesProvider", () => ({
  useLiveReload: (tables: Iterable<string>, reload: () => void, options: { paused?: boolean } = {}) => {
    live.tables = [...tables];
    live.reload = reload;
    live.paused = options.paused ?? false;
  },
}));

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const TABLES = ["payees", "transactions"];
const options = (load: () => Promise<string[]>, paused = false) => ({
  initial: [] as string[], load, tables: TABLES, paused,
  loadError: "Could not load payees.", refreshError: "Could not refresh payees.",
});

beforeEach(() => { toast.error.mockClear(); });

describe("useBookResource", () => {
  it("is loading until the first answer, then gives the data", async () => {
    const first = deferred<string[]>();
    const { result } = renderHook(() => useBookResource(options(() => first.promise)));
    expect(result.current).toMatchObject({ data: [], loading: true, error: null });
    await act(async () => { first.resolve(["Ikea"]); });
    expect(result.current).toMatchObject({ data: ["Ikea"], loading: false, error: null });
  });

  it("shows the load error when the first load fails, and no toast", async () => {
    const { result } = renderHook(() => useBookResource(options(() => Promise.reject(new Error("down")))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: [], error: "Could not load payees." });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the data and shows a toast when a reload fails", async () => {
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(["Ikea"]).mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useBookResource(options(load)));
    await waitFor(() => expect(result.current.data).toEqual(["Ikea"]));
    await act(async () => { await result.current.reload(); });
    expect(result.current).toMatchObject({ data: ["Ikea"], loading: false, error: null });
    expect(toast.error).toHaveBeenCalledWith("Could not refresh payees.");
  });

  it("clears the error when a later load succeeds", async () => {
    const load = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(["Ikea"]);
    const { result } = renderHook(() => useBookResource(options(load)));
    await waitFor(() => expect(result.current.error).toBe("Could not load payees."));
    await act(async () => { await result.current.reload(); });
    expect(result.current).toMatchObject({ data: ["Ikea"], error: null });
  });

  it("shows only the answer of the latest request", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const load = vi.fn<() => Promise<string[]>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useBookResource(options(load)));
    act(() => { void result.current.reload(); });
    await act(async () => { second.resolve(["new"]); });
    expect(result.current.data).toEqual(["new"]);
    // The answer of the first request arrives last. It must not go on the screen.
    await act(async () => { first.resolve(["old"]); });
    expect(result.current.data).toEqual(["new"]);
  });

  it("does not report the failure of a request that a later one replaced", async () => {
    const first = deferred<string[]>();
    const load = vi.fn<() => Promise<string[]>>().mockReturnValueOnce(first.promise).mockResolvedValueOnce(["new"]);
    const { result } = renderHook(() => useBookResource(options(load)));
    await act(async () => { await result.current.reload(); });
    await act(async () => { first.reject(new Error("down")); });
    expect(result.current).toMatchObject({ data: ["new"], error: null });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("loads again for a new load function, and its first failure is a load error", async () => {
    const bookOne = vi.fn<() => Promise<string[]>>().mockResolvedValue(["Ikea"]);
    const bookTwo = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error("down"));
    const { result, rerender } = renderHook(({ load }) => useBookResource(options(load)), { initialProps: { load: bookOne } });
    await waitFor(() => expect(result.current.data).toEqual(["Ikea"]));
    rerender({ load: bookTwo });
    await waitFor(() => expect(result.current.error).toBe("Could not load payees."));
    expect(bookTwo).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not load again when only the other options change", async () => {
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValue(["Ikea"]);
    const { result, rerender } = renderHook(({ paused }) => useBookResource(options(load, paused)), { initialProps: { paused: false } });
    await waitFor(() => expect(result.current.data).toEqual(["Ikea"]));
    rerender({ paused: true });
    rerender({ paused: false });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("gives its tables and the pause to the live reload, which starts a reload", async () => {
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(["Ikea"]).mockResolvedValueOnce(["Ikea", "Aldi"]);
    const { result } = renderHook(() => useBookResource(options(load, true)));
    await waitFor(() => expect(result.current.data).toEqual(["Ikea"]));
    expect(live.tables).toEqual(TABLES);
    expect(live.paused).toBe(true);
    await act(async () => { live.reload(); });
    expect(result.current.data).toEqual(["Ikea", "Aldi"]);
  });

  it("lets the page change the data between loads", async () => {
    const { result } = renderHook(() => useBookResource(options(() => Promise.resolve(["Ikea"]))));
    await waitFor(() => expect(result.current.data).toEqual(["Ikea"]));
    act(() => { result.current.setData((old) => [...old, "Aldi"]); });
    expect(result.current.data).toEqual(["Ikea", "Aldi"]);
  });
});
