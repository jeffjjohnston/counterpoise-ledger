import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookChangeHub, type ListenForChanges } from "@/lib/book-change-hub";

function fixture() {
  let notify!: (payload: string) => void;
  let onReady!: () => void;
  let finish!: (value: { unlisten: () => Promise<void> }) => void;
  const unlisten = vi.fn(async () => {});
  const listen: ListenForChanges = vi.fn((n, r) => {
    notify = n; onReady = r;
    return new Promise<{ unlisten: () => Promise<void> }>((resolve) => { finish = resolve; });
  });
  const hub = createBookChangeHub(listen);
  return { hub, listen, unlisten,
    connected() { onReady(); finish({ unlisten }); },
    reconnect() { onReady(); },
    send(bookId: number, table: string) { notify(JSON.stringify({ bookId, table })); },
    raw(payload: string) { notify(payload); },
  };
}

afterEach(() => { vi.useRealTimers(); });
describe("book change hub", () => {
  it("shares initialization, coalesces tables, and isolates books", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const mine = vi.fn(), theirs = vi.fn();
    const a = f.hub.subscribe(1, mine);
    const b = f.hub.subscribe(2, theirs);
    expect(f.listen).toHaveBeenCalledTimes(1);
    f.connected();
    await Promise.all([a.ready, b.ready]);
    mine.mockClear(); theirs.mockClear();
    f.send(1, "transactions"); f.send(1, "transactions"); f.send(1, "security_prices");
    f.raw("not json"); f.raw('{"bookId":1,"table":"sessions"}');
    await vi.advanceTimersByTimeAsync(250);
    expect(mine).toHaveBeenCalledExactlyOnceWith({ type: "change", tables: ["transactions", "security_prices"] });
    expect(theirs).not.toHaveBeenCalled();
    f.send(2, "books");
    await vi.advanceTimersByTimeAsync(250);
    expect(theirs).toHaveBeenCalledExactlyOnceWith({ type: "change", tables: ["books"] });
    await f.hub.dispose();
  });

  it("resets after reconnect and releases pending work when unsubscribed", async () => {
    vi.useFakeTimers();
    const f = fixture(); const callback = vi.fn();
    const sub = f.hub.subscribe(1, callback);
    f.connected(); await sub.ready; callback.mockClear();
    f.reconnect();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ type: "reset", tables: [] });
    f.send(1, "accounts"); sub.unsubscribe(); callback.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(callback).not.toHaveBeenCalled();
    await f.hub.dispose();
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });

  it("a broken subscriber cannot prevent delivery to others", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.hub.subscribe(1, () => { throw new Error("closed stream"); });
    const callback = vi.fn(); const sub = f.hub.subscribe(1, callback);
    f.connected(); await sub.ready; callback.mockClear();
    f.send(1, "accounts"); await vi.advanceTimersByTimeAsync(250);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ type: "change", tables: ["accounts"] });
    await f.hub.dispose();
  });
});
