import { describe, expect, it } from "vitest";
import { rangeStart } from "@/lib/chart-range";

describe("rangeStart", () => {
  it("gives one or five years back, or no start for all history", () => {
    const today = new Date(2026, 9, 2);
    expect(rangeStart("1Y", today)).toBe("2025-10-02");
    expect(rangeStart("5Y", today)).toBe("2021-10-02");
    expect(rangeStart("All", today)).toBeNull();
  });
});
