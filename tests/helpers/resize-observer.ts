import { vi } from "vitest";

/**
 * jsdom has no ResizeObserver. This stub reports one width at once when a
 * chart starts to observe its container.
 */
export function stubResizeObserver(width = 600): void {
  class StubResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
}
