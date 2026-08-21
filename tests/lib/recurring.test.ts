import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  getOccurrenceDate,
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

describe("getOccurrenceDate", () => {
  it("returns the scheduled date unchanged when the rule is not business-days-only", () => {
    // 2026-08-15 is a Saturday
    expect(getOccurrenceDate("2026-08-15", false)).toBe("2026-08-15");
  });

  it("shifts a weekend occurrence to the following Monday", () => {
    expect(getOccurrenceDate("2026-08-15", true)).toBe("2026-08-17");
    expect(getOccurrenceDate("2026-08-16", true)).toBe("2026-08-17");
  });

  it("leaves a weekday occurrence alone", () => {
    // 2026-08-14 is a Friday
    expect(getOccurrenceDate("2026-08-14", true)).toBe("2026-08-14");
  });
});

describe("isRecurringRuleDue with businessDaysOnly", () => {
  it("is not due on the weekend the occurrence is scheduled for", () => {
    // Saturday 2026-08-15, checked on that Saturday
    expect(isRecurringRuleDue("2026-08-15", "2026-08-15", 0, true)).toBe(false);
    // Without the option the same rule is due that day
    expect(isRecurringRuleDue("2026-08-15", "2026-08-15", 0, false)).toBe(true);
  });

  it("becomes due on the Monday the occurrence lands on", () => {
    expect(isRecurringRuleDue("2026-08-15", "2026-08-17", 0, true)).toBe(true);
  });

  it("measures the lead window against the shifted date", () => {
    // Two days before Saturday 2026-08-15 is Thursday, but the occurrence is
    // observed on Monday 2026-08-17 — four days out, so still not due.
    expect(isRecurringRuleDue("2026-08-15", "2026-08-13", 2, true)).toBe(false);
    expect(isRecurringRuleDue("2026-08-15", "2026-08-13", 4, true)).toBe(true);
  });
});
