import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookChangesProvider, useBookChanges } from "@/components/BookChangesProvider";
import { FakeEventSource } from "@/tests/helpers/event-source";
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
beforeEach(() => { bookId = "1"; FakeEventSource.instances = []; vi.stubGlobal("EventSource", FakeEventSource); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("shared book changes", () => {
  it("shares one stream, catches up on readiness/reconnect/focus, and coalesces bursts", async () => {
    const view = render(<BookChangesProvider><Consumer name="page" /><Consumer name="badge" /></BookChangesProvider>);
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    source.emit("ready"); source.emit("change", { tables: ["accounts"] }); source.emit("change", { tables: ["transactions"] });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("1");
    expect(screen.getByLabelText("badge")).toHaveTextContent("1");
    source.emit("reset");
    await act(() => vi.advanceTimersByTimeAsync(100));
    window.dispatchEvent(new Event("focus"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("3");
    expect(FakeEventSource.instances).toHaveLength(1);
    view.unmount(); expect(source.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("closes on book switch/logout and ignores obsolete callbacks", async () => {
    const children = <Consumer name="page" />;
    const view = render(<BookChangesProvider>{children}</BookChangesProvider>);
    const old = FakeEventSource.instances[0];
    bookId = "2";
    view.rerender(<BookChangesProvider>{children}</BookChangesProvider>);
    expect(old.closed).toBe(true);
    expect(FakeEventSource.instances[1].url).toBe("/api/b/2/events");
    old.emit("ready");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("0");
    window.dispatchEvent(new Event(BOOK_SESSION_ENDED_EVENT));
    expect(FakeEventSource.instances[1].closed).toBe(true);
    FakeEventSource.instances[1].emit("ready");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("page")).toHaveTextContent("0");
  });
});
