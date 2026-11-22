import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReloadsInFlight } from "@/hooks/useLatestRequest";

describe("useReloadsInFlight", () => {
  it("gives null when no reload is in flight", () => {
    const { result } = renderHook(() => useReloadsInFlight());
    expect(result.current.settled()).toBeNull();
    const end = result.current.begin();
    expect(result.current.settled()).not.toBeNull();
    end();
    expect(result.current.settled()).toBeNull();
  });

  it("resolves only when all overlapping reloads have ended, in either order", async () => {
    const { result } = renderHook(() => useReloadsInFlight());
    const endOlder = result.current.begin();
    const endNewer = result.current.begin();
    const wait = result.current.settled()!;
    let resolved = false;
    void wait.then(() => { resolved = true; });

    // The newer reload ends first. The older one is still in flight.
    endNewer();
    await Promise.resolve();
    expect(resolved).toBe(false);
    // The same pending promise: a loop that waits on it does not spin.
    expect(result.current.settled()).toBe(wait);

    endOlder();
    await wait;
    expect(resolved).toBe(true);
    expect(result.current.settled()).toBeNull();
  });

  it("counts an end function one time", () => {
    const { result } = renderHook(() => useReloadsInFlight());
    const endFirst = result.current.begin();
    const endSecond = result.current.begin();
    endFirst();
    endFirst();
    expect(result.current.settled()).not.toBeNull();
    endSecond();
    expect(result.current.settled()).toBeNull();
  });
});
