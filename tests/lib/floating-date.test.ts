import { describe, it, expect, vi, afterEach } from "vitest";
import { getEffectiveDate } from "@/lib/accounting";

describe("getEffectiveDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the stored date when not floating", () => {
    expect(getEffectiveDate({ date: "2025-03-15", isFloating: false })).toBe("2025-03-15");
  });

  it("returns today's date when floating", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 3, 10, 12, 0, 0));
    expect(getEffectiveDate({ date: "2025-03-15", isFloating: true })).toBe("2026-04-10");
    vi.useRealTimers();
  });

  it("returns stored date for floating=false even if date is old", () => {
    expect(getEffectiveDate({ date: "2020-01-01", isFloating: false })).toBe("2020-01-01");
  });
});
