import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIsMobile } from "@/hooks/useIsMobile";

describe("useIsMobile", () => {
  let listeners: Map<string, (e: MediaQueryListEvent | MediaQueryList) => void>;
  let currentMatches: boolean;

  beforeEach(() => {
    listeners = new Map();
    currentMatches = false;

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: currentMatches,
        media: query,
        addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent | MediaQueryList) => void) => {
          listeners.set(event, handler);
        }),
        removeEventListener: vi.fn((event: string) => {
          listeners.delete(event);
        }),
      })),
    });
  });

  it("returns false by default (desktop)", () => {
    currentMatches = false;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("returns true when media query matches (mobile)", () => {
    currentMatches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("updates when media query changes", () => {
    currentMatches = false;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    const changeHandler = listeners.get("change");
    if (changeHandler) {
      act(() => {
        changeHandler({ matches: true } as MediaQueryListEvent);
      });
    }
    expect(result.current).toBe(true);
  });

  it("queries max-width: 767px (Tailwind md breakpoint - 1)", () => {
    renderHook(() => useIsMobile());
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  });
});
