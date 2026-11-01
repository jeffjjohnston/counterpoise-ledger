import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_RETURN_MS, onTabReturn } from "@/lib/tab-return";

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("onTabReturn", () => {
  it("makes one call of the focus and visibilitychange of one return", () => {
    const callback = vi.fn();
    const stop = onTabReturn(callback);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(TAB_RETURN_MS);
    expect(callback).toHaveBeenCalledTimes(1);
    // A later return calls again.
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(TAB_RETURN_MS);
    expect(callback).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a hidden tab, and stops when removed", () => {
    const callback = vi.fn();
    const stop = onTabReturn(callback);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(TAB_RETURN_MS);
    expect(callback).not.toHaveBeenCalled();
    visibility = "visible";
    window.dispatchEvent(new Event("focus"));
    stop();
    vi.advanceTimersByTime(TAB_RETURN_MS);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(TAB_RETURN_MS);
    expect(callback).not.toHaveBeenCalled();
  });
});
