import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookChangesProvider, useBookChanges, useBookChangesLive } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";
import { BOOK_SESSION_ENDED_EVENT } from "@/lib/events";
let bookId = "1";
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId }),
  })
);
function Consumer({ name }: { name: string }) {
  const [changes, setChanges] = useState(0);
  useBookChanges(() => setChanges((n) => n + 1));
  return <output aria-label={name}>{changes}</output>;
}
function LiveProbe({ onLive }: { onLive: (live: () => boolean) => void }) {
  onLive(useBookChangesLive());
  return null;
}
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
/** The status of the plain GET that follows a failed handshake. */
let probe = 400;
const probes: string[] = [];
beforeEach(() => {
  bookId = "1"; FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket); vi.useFakeTimers();
  probe = 400; probes.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    probes.push(input);
    return new Response(null, { status: probe });
  }));
  // The longest delay of each retry: no jitter below it.
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("shared book changes", () => {
  it("shares one socket, catches up on readiness and focus, and coalesces bursts", async () => {
    const view = render(<BookChangesProvider><Consumer name="page" /><Consumer name="badge" /></BookChangesProvider>);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toMatch(/^ws:\/\/[^/]+\/api\/b\/1\/socket$/);
    socket.emit("ready"); socket.emit("change", { tables: ["accounts"] }); socket.emit("change", { tables: ["transactions"] });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("1");
    expect(screen.getByLabelText("badge")).toHaveTextContent("1");
    // A malformed or unknown message changes nothing.
    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }));
    socket.emit("change", { tables: [1] });
    socket.emit("other");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("1");
    window.dispatchEvent(new Event("focus"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("2");
    expect(FakeWebSocket.instances).toHaveLength(1);
    view.unmount(); expect(socket.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("reports the socket as live from its readiness until it closes", async () => {
    let live = () => true;
    const view = render(<BookChangesProvider><LiveProbe onLive={(probe) => { live = probe; }} /></BookChangesProvider>);
    expect(live()).toBe(false);
    latest().emit("ready");
    expect(live()).toBe(true);
    latest().drop(1013);
    expect(live()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(live()).toBe(false);
    latest().emit("ready");
    expect(live()).toBe(true);
    view.unmount();
    expect(live()).toBe(false);
  });
  it("reports no live socket outside a book layout", () => {
    let live = () => true;
    render(<LiveProbe onLive={(probe) => { live = probe; }} />);
    expect(live()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
  it("reconnects with a growing delay, and at once when the tab returns", async () => {
    const view = render(<BookChangesProvider><Consumer name="page" /></BookChangesProvider>);
    // A handshake that fails before `ready` checks the route first.
    latest().drop();
    await act(async () => {});
    expect(probes).toEqual(["/api/b/1/socket"]);
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().drop(1001);
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(3);
    // Readiness resets the delay, and catches up on what the gap missed.
    latest().emit("ready");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("1");
    // A socket that was open retries without the check.
    latest().drop(1013);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(probes).toHaveLength(2);
    // A focused tab does not wait for its retry.
    latest().drop();
    await act(async () => {});
    window.dispatchEvent(new Event("focus"));
    expect(FakeWebSocket.instances).toHaveLength(5);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stays closed when the server refuses the credential", async () => {
    const view = render(<BookChangesProvider><Consumer name="page" /></BookChangesProvider>);
    latest().emit("ready");
    latest().drop(4401);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    window.dispatchEvent(new Event("focus"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(probes).toEqual([]);
    view.unmount();
  });
  it.each([401, 403, 404])("stays closed when the handshake is refused with %i", async (status) => {
    const view = render(<BookChangesProvider><Consumer name="page" /></BookChangesProvider>);
    probe = status;
    latest().drop();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    window.dispatchEvent(new Event("focus"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(probes).toHaveLength(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reloads the page when Cloudflare Access refuses the handshake", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return { type: "opaqueredirect", status: 0 } as Response;
    }));
    const view = render(<BookChangesProvider><Consumer name="page" /></BookChangesProvider>);
    latest().drop();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    view.unmount();
  });
  it("retries when the check after a failed handshake does not answer", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }));
    const view = render(<BookChangesProvider><Consumer name="page" /></BookChangesProvider>);
    latest().drop();
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(signal?.aborted).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Leaving while a check waits ends it.
    latest().drop();
    await act(async () => {});
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes on book switch/logout and ignores obsolete callbacks", async () => {
    const children = <Consumer name="page" />;
    const view = render(<BookChangesProvider>{children}</BookChangesProvider>);
    const old = FakeWebSocket.instances[0];
    bookId = "2";
    view.rerender(<BookChangesProvider>{children}</BookChangesProvider>);
    expect(old.closed).toBe(true);
    expect(FakeWebSocket.instances[1].url).toMatch(/\/api\/b\/2\/socket$/);
    old.emit("ready");
    old.drop();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByLabelText("page")).toHaveTextContent("0");
    expect(FakeWebSocket.instances).toHaveLength(2);
    window.dispatchEvent(new Event(BOOK_SESSION_ENDED_EVENT));
    expect(FakeWebSocket.instances[1].closed).toBe(true);
    FakeWebSocket.instances[1].emit("ready");
    FakeWebSocket.instances[1].drop();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByLabelText("page")).toHaveTextContent("0");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
