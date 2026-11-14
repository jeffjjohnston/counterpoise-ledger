import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookChangesProvider, useLiveReload } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({ useParams: () => ({ bookId: "1" }) })
);

// BookChangesProvider holds socket hints for 100 ms, then sends one change.
const BATCH_MS = 100;
const reload = vi.fn();

function Page() {
  const [paused, setPaused] = useState(false);
  useLiveReload(["payees", "transactions"], reload, { paused });
  return <button onClick={() => setPaused(!paused)}>{paused ? "Close editor" : "Edit"}</button>;
}

function socket() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
async function send(type: string, data: object = {}) {
  socket().emit(type, data);
  await act(() => vi.advanceTimersByTimeAsync(BATCH_MS));
}

beforeEach(() => {
  FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket); vi.useFakeTimers();
  reload.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useLiveReload", () => {
  it("reloads on a change to a table that the page reads, and on a reset", async () => {
    render(<BookChangesProvider><Page /></BookChangesProvider>);
    await send("change", { tables: ["securities"] });
    expect(reload).not.toHaveBeenCalled();
    await send("change", { tables: ["payees"] });
    expect(reload).toHaveBeenCalledTimes(1);
    await send("ready");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("keeps the changes while paused and reloads one time when the pause ends", async () => {
    render(<BookChangesProvider><Page /></BookChangesProvider>);
    fireEvent.click(screen.getByText("Edit"));
    await send("change", { tables: ["payees"] });
    await send("change", { tables: ["transactions"] });
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Close editor"));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Close editor"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside a book layout", () => {
    render(<Page />);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });
});
