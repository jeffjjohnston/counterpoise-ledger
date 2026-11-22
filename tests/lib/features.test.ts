// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDots, isDotCleared, isFeatureNew, isFeatureStorageEvent, recordFirstSeen, shouldShowDot } from "@/lib/features";

describe("features", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("is new on first sight and for 60 days", () => {
    expect(isFeatureNew("typesafe", "2026-11-17")).toBe(true);
    recordFirstSeen(["typesafe"], "2026-11-17");
    expect(isFeatureNew("typesafe", "2027-01-15")).toBe(true); // day 59
    expect(isFeatureNew("typesafe", "2027-01-16")).toBe(false); // day 60
  });

  it("counts from first sight, not from a later record", () => {
    recordFirstSeen(["weekly-review"], "2026-01-01");
    recordFirstSeen(["weekly-review"], "2026-11-17");
    expect(isFeatureNew("weekly-review", "2026-11-17")).toBe(false);
  });

  it("a read of isFeatureNew writes nothing, so a render can call it", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(isFeatureNew("typesafe", "2026-01-01")).toBe(true);
    expect(write).not.toHaveBeenCalled();
    // No first sight was recorded: the feature is new a year later.
    expect(isFeatureNew("typesafe", "2027-01-01")).toBe(true);
  });

  it("replaces stored text that is not JSON", () => {
    localStorage.setItem("counterpoise:feature-dot-cleared", "{not json");
    localStorage.setItem("counterpoise:feature-first-seen", "[1,");
    expect(isDotCleared("1", "typesafe")).toBe(false);
    clearDots("1", ["typesafe"]);
    expect(isDotCleared("1", "typesafe")).toBe(true);

    expect(isFeatureNew("typesafe", "2026-11-17")).toBe(true);
    recordFirstSeen(["typesafe"], "2026-01-01");
    expect(isFeatureNew("typesafe", "2026-11-17")).toBe(false);
  });

  it("sends the dots event only when a dot changes", () => {
    const heard = vi.fn();
    window.addEventListener("counterpoise:feature-dots", heard);
    clearDots("1", ["typesafe"]);
    clearDots("1", ["typesafe"]);
    window.removeEventListener("counterpoise:feature-dots", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("knows the storage events that can change a dot", () => {
    const event = (key: string | null) => new StorageEvent("storage", { key });
    expect(isFeatureStorageEvent(event("counterpoise:feature-dot-cleared"))).toBe(true);
    expect(isFeatureStorageEvent(event("counterpoise:feature-first-seen"))).toBe(true);
    expect(isFeatureStorageEvent(event(null))).toBe(true);
    expect(isFeatureStorageEvent(event("theme"))).toBe(false);
  });

  it("storage that throws gives no badge", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("x");
    });
    expect(isFeatureNew("typesafe", "2026-11-17")).toBe(false);
  });

  it("clears dots per book", () => {
    clearDots("1", ["typesafe"]);
    expect(isDotCleared("1", "typesafe")).toBe(true);
    expect(isDotCleared("2", "typesafe")).toBe(false);
  });

  it.each([
    [{ isNew: true, cleared: false, state: { enabled: false, configured: true }, canWrite: true }, true],
    [{ isNew: true, cleared: false, state: { enabled: true, configured: true }, canWrite: true }, false],
    [{ isNew: true, cleared: false, state: { enabled: false, configured: false }, canWrite: true }, false],
    [{ isNew: true, cleared: false, state: { enabled: false, configured: true }, canWrite: false }, false],
    [{ isNew: true, cleared: true, state: { enabled: false, configured: true }, canWrite: true }, false],
    [{ isNew: false, cleared: false, state: { enabled: false, configured: true }, canWrite: true }, false],
    // AI suggestions with only the entry switch on is on.
    [{ isNew: true, cleared: false, state: { enabled: false, entrySuggestionsEnabled: true, configured: true }, canWrite: true }, false],
  ])("shouldShowDot %#", (args, expected) => expect(shouldShowDot(args)).toBe(expected));
});
