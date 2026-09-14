import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  getOccurrenceDate,
  isRecurringRuleDue,
  parseAutoCreateDaysBefore,
  previewOccurrences,
  scheduleKey,
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

describe("previewOccurrences", () => {
  // The form asks for four to six schedule controls and, until this change,
  // rendered no output — the single reason all three schedule defects fixed
  // alongside the preview were invisible in the form and obvious in the rule
  // list one screen away.
  // The preview has to agree with what a save will actually produce, so it
  // derives dates the same way updateRecurringRule does.
  const weeklyEveryFourWeeks = {
    frequency: "weekly" as const,
    interval: 4,
  };

  it("derives the dates a save would produce from the start date", () => {
    expect(
      previewOccurrences({
        config: weeklyEveryFourWeeks,
        startDate: "2025-04-01", // a Tuesday
        count: 3,
        today: "2026-08-27",
      })
    ).toEqual(["2026-09-15", "2026-10-13", "2026-11-10"]);
  });

  it("walks from an existing nextDate when one is supplied", () => {
    // An edit that leaves the schedule alone keeps the rule's stored nextDate,
    // so the preview must start there rather than re-deriving from the start
    // date and showing a cadence off by a day.
    expect(
      previewOccurrences({
        config: weeklyEveryFourWeeks,
        startDate: "2025-04-01",
        seed: "2026-09-14", // a Monday — the cadence the rule actually runs on
        count: 3,
        today: "2026-08-27",
      })
    ).toEqual(["2026-09-14", "2026-10-12", "2026-11-09"]);
  });

  it("reports the observed dates for a business-days-only rule", () => {
    // A Saturday occurrence is created on the Monday, so the Monday is what
    // the preview must show — the same shift getOccurrenceDate applies
    // everywhere else a scheduled date becomes a transaction date.
    expect(
      previewOccurrences({
        config: { frequency: "weekly", interval: 1, daysOfWeek: [6] },
        startDate: "2026-09-05", // a Saturday
        businessDaysOnly: true,
        count: 2,
        today: "2026-09-01",
      })
    ).toEqual(["2026-09-07", "2026-09-14"]);
  });
});

describe("scheduleKey", () => {
  // The key exists to answer "did the schedule change", and getNextDate() is
  // the only thing that turns a schedule into dates. Any field outside the
  // branch it takes for this frequency cannot move a single occurrence, so
  // reporting a change on one re-anchors a cadence for no reason.
  it("ignores day fields the frequency's getNextDate branch never reads", () => {
    // A monthly rule still carrying daysOfWeek and weekOfMonth from a former
    // weekly schedule: reachable because a partial update writes only the
    // columns its input names.
    const stale = scheduleKey({
      frequency: "monthly",
      interval: 1,
      daysOfWeek: [1],
      weekOfMonth: "2",
      daysOfMonth: [15],
    });
    // What the edit form posts for that rule — it nulls every field the
    // current frequency does not use.
    const posted = scheduleKey({
      frequency: "monthly",
      interval: 1,
      daysOfWeek: null,
      weekOfMonth: null,
      daysOfMonth: [15],
    });
    expect(stale).toBe(posted);
  });

  it("ignores daysOfMonth on a weekly rule", () => {
    const config = {
      frequency: "weekly",
      interval: 1,
      daysOfWeek: [1],
      weekOfMonth: "every",
    };
    expect(scheduleKey({ ...config, daysOfMonth: [15] })).toBe(
      scheduleKey({ ...config, daysOfMonth: null })
    );
  });

  it("ignores every day field on daily and yearly rules", () => {
    for (const frequency of ["daily", "yearly"]) {
      expect(
        scheduleKey({
          frequency,
          interval: 2,
          daysOfWeek: [1],
          weekOfMonth: "2",
          daysOfMonth: [15],
        })
      ).toBe(scheduleKey({ frequency, interval: 2 }));
    }
  });

  it("still reports a change to a field the frequency does read", () => {
    expect(scheduleKey({ frequency: "monthly", daysOfMonth: [15] })).not.toBe(
      scheduleKey({ frequency: "monthly", daysOfMonth: [16] })
    );
    expect(scheduleKey({ frequency: "weekly", daysOfWeek: [1] })).not.toBe(
      scheduleKey({ frequency: "weekly", daysOfWeek: [2] })
    );
    expect(
      scheduleKey({ frequency: "weekly", daysOfWeek: [1], weekOfMonth: "2" })
    ).not.toBe(
      scheduleKey({ frequency: "weekly", daysOfWeek: [1], weekOfMonth: "last" })
    );
    expect(scheduleKey({ frequency: "daily", interval: 1 })).not.toBe(
      scheduleKey({ frequency: "daily", interval: 2 })
    );
    expect(scheduleKey({ frequency: "monthly" })).not.toBe(
      scheduleKey({ frequency: "yearly" })
    );
  });

  it("keeps treating the spellings the form and the column disagree on as one", () => {
    expect(
      scheduleKey({ frequency: "weekly", daysOfWeek: [], weekOfMonth: "every" })
    ).toBe(scheduleKey({ frequency: "weekly", daysOfWeek: null, weekOfMonth: null }));
    expect(
      scheduleKey({ frequency: "weekly", daysOfWeek: [1], weekOfMonth: "" })
    ).toBe(
      scheduleKey({ frequency: "weekly", daysOfWeek: [1], weekOfMonth: "every" })
    );
  });

  it("sorts a day list rather than comparing its order", () => {
    expect(scheduleKey({ frequency: "weekly", daysOfWeek: [3, 1] })).toBe(
      scheduleKey({ frequency: "weekly", daysOfWeek: [1, 3] })
    );
  });
});
