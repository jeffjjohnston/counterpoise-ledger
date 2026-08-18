import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  isRecurringRuleDue,
  parseAutoCreateDaysBefore,
} from "@/lib/recurring";

describe("parseAutoCreateDaysBefore", () => {
  it("defaults to fallback when undefined", () => {
    expect(parseAutoCreateDaysBefore(undefined, 0)).toBe(0);
    expect(parseAutoCreateDaysBefore(undefined, 3)).toBe(3);
  });

  it("accepts integer values in range", () => {
    expect(parseAutoCreateDaysBefore(0)).toBe(0);
    expect(parseAutoCreateDaysBefore(30)).toBe(30);
    expect(parseAutoCreateDaysBefore(7)).toBe(7);
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(parseAutoCreateDaysBefore(-1)).toBeNull();
    expect(parseAutoCreateDaysBefore(31)).toBeNull();
    expect(parseAutoCreateDaysBefore(1.5)).toBeNull();
    expect(parseAutoCreateDaysBefore("2")).toBeNull();
  });
});

describe("due date helpers", () => {
  it("adds days to yyyy-mm-dd strings", () => {
    expect(addDaysToDateString("2026-02-10", 3)).toBe("2026-02-13");
  });

  it("marks rules due inside the lead window", () => {
    expect(isRecurringRuleDue("2026-02-13", "2026-02-10", 3)).toBe(true);
  });

  it("does not mark rules due outside the lead window", () => {
    expect(isRecurringRuleDue("2026-02-13", "2026-02-10", 2)).toBe(false);
  });
});
