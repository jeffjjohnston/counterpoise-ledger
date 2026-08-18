import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatPriceMicrosInput,
  formatDate,
  formatDateShort,
  toDateString,
  parseCurrency,
  parseStrictCurrency,
  getAccountShortName,
  resolveAmountOnBlur,
  isValidDateString,
  formatRelativeAge,
} from "@/lib/formatters";

describe("formatCurrency", () => {
  it("formats positive amounts correctly", () => {
    expect(formatCurrency(12543)).toBe("$125.43");
  });

  it("formats zero correctly", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats negative amounts with a Unicode minus (U+2212)", () => {
    expect(formatCurrency(-5000)).toBe("−$50.00");
  });

  it("formats large amounts with commas", () => {
    expect(formatCurrency(1234567)).toBe("$12,345.67");
  });

  it("handles single cent", () => {
    expect(formatCurrency(1)).toBe("$0.01");
  });

  it("handles amounts without cents", () => {
    expect(formatCurrency(10000)).toBe("$100.00");
  });
});

describe("parseCurrency", () => {
  it("parses simple dollar amount", () => {
    expect(parseCurrency("125.43")).toBe(12543);
  });

  it("parses amount with dollar sign", () => {
    expect(parseCurrency("$125.43")).toBe(12543);
  });

  it("parses amount with commas", () => {
    expect(parseCurrency("1,234.56")).toBe(123456);
  });

  it("parses amount with dollar sign and commas", () => {
    expect(parseCurrency("$1,234.56")).toBe(123456);
  });

  it("parses negative amounts", () => {
    expect(parseCurrency("-50.00")).toBe(-5000);
  });

  it("parses negatives written with a Unicode minus (U+2212)", () => {
    expect(parseCurrency("−$50.00")).toBe(-5000);
  });

  it("returns 0 for empty string", () => {
    expect(parseCurrency("")).toBe(0);
  });

  it("returns 0 for non-numeric string", () => {
    expect(parseCurrency("abc")).toBe(0);
  });

  it("parses whole numbers", () => {
    expect(parseCurrency("100")).toBe(10000);
  });

  it("handles single decimal place", () => {
    expect(parseCurrency("10.5")).toBe(1050);
  });

  it("rounds to nearest cent", () => {
    expect(parseCurrency("10.555")).toBe(1056);
    expect(parseCurrency("10.554")).toBe(1055);
  });
});

describe("parseStrictCurrency", () => {
  it("parses a valid decimal amount", () => {
    expect(parseStrictCurrency("125.43")).toBe(12543);
  });

  it("accepts leading and trailing decimal shorthand", () => {
    expect(parseStrictCurrency(".5")).toBe(50);
    expect(parseStrictCurrency("5.")).toBe(500);
  });

  it("returns null for malformed numeric input", () => {
    expect(parseStrictCurrency("1..2")).toBeNull();
  });

  it("returns null for invalid expressions", () => {
    expect(parseStrictCurrency("12+")).toBeNull();
    expect(parseStrictCurrency("1/0")).toBeNull();
  });

  it("parses a Unicode-minus negative", () => {
    expect(parseStrictCurrency("−50.00")).toBe(-5000);
  });
});

describe("formatDate", () => {
  it("formats date correctly", () => {
    expect(formatDate("2026-01-15")).toBe("Jan 15, 2026");
  });

  it("formats different months", () => {
    expect(formatDate("2026-06-01")).toBe("Jun 1, 2026");
    expect(formatDate("2026-12-25")).toBe("Dec 25, 2026");
  });

  it("handles year transitions", () => {
    expect(formatDate("2025-12-31")).toBe("Dec 31, 2025");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  });
});

describe("isValidDateString", () => {
  it("accepts a well-formed YYYY-MM-DD date", () => {
    expect(isValidDateString("2026-01-15")).toBe(true);
    expect(isValidDateString("2025-12-31")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidDateString("")).toBe(false);
  });

  it("rejects non-date garbage that would make formatDate throw", () => {
    expect(isValidDateString("abc")).toBe(false);
    expect(isValidDateString("not-a-date")).toBe(false);
  });

  it("rejects malformed or out-of-range dates", () => {
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-1-5")).toBe(false);
    expect(isValidDateString("01/15/2026")).toBe(false);
  });

  it("does not throw and stays consistent with formatDate", () => {
    // Anything isValidDateString accepts must be safe to pass to formatDate.
    expect(() => formatDate("2026-01-15")).not.toThrow();
    expect(isValidDateString("2026-01-15")).toBe(true);
  });
});

describe("formatDateShort", () => {
  it("formats date without year", () => {
    expect(formatDateShort("2026-01-15")).toBe("Jan 15");
  });

  it("formats different months", () => {
    expect(formatDateShort("2026-06-01")).toBe("Jun 1");
    expect(formatDateShort("2026-12-25")).toBe("Dec 25");
  });
});

describe("toDateString", () => {
  it("converts Date to YYYY-MM-DD string", () => {
    const date = new Date("2026-01-15T12:00:00Z");
    expect(toDateString(date)).toBe("2026-01-15");
  });

  it("pads single-digit months and days", () => {
    const date = new Date("2026-05-05T12:00:00Z");
    expect(toDateString(date)).toBe("2026-05-05");
  });

  it("handles year boundaries", () => {
    const date = new Date("2025-12-31T12:00:00Z");
    expect(toDateString(date)).toBe("2025-12-31");
  });

  it("uses local date components, not UTC", () => {
    // Construct a date with known local components (year, month, day)
    const date = new Date(2026, 3, 10); // April 10, 2026 at midnight local
    expect(toDateString(date)).toBe("2026-04-10");
  });

  it("returns the local date for a late local time", () => {
    // Use a late local time and verify the formatter still returns the local date.
    const date = new Date(2026, 3, 10, 23, 30, 0); // April 10, 2026 at 11:30 PM local
    expect(toDateString(date)).toBe("2026-04-10");
  });

  it("throws on invalid date", () => {
    expect(() => toDateString(new Date(NaN))).toThrow("Invalid date");
  });
});

describe("currency round-trip", () => {
  it("formats and parses back to same value", () => {
    const original = 12543;
    const formatted = formatCurrency(original);
    const parsed = parseCurrency(formatted);
    expect(parsed).toBe(original);
  });

  it("handles large amounts in round-trip", () => {
    const original = 12345678;
    const formatted = formatCurrency(original);
    const parsed = parseCurrency(formatted);
    expect(parsed).toBe(original);
  });

  it("round-trips a negative value despite the Unicode minus", () => {
    const original = -5000;
    const parsed = parseCurrency(formatCurrency(original));
    expect(parsed).toBe(original);
  });
});

describe("getAccountShortName", () => {
  it("returns full name for accounts without colon", () => {
    expect(getAccountShortName("Automobile")).toBe("Automobile");
  });

  it("extracts short name from child account with single parent", () => {
    expect(getAccountShortName("Automobile:Lease")).toBe("Lease");
  });

  it("extracts short name from deeply nested account", () => {
    expect(getAccountShortName("Business:Expenses:Travel:Airfare")).toBe("Airfare");
  });

  it("handles account names with colon at the end", () => {
    expect(getAccountShortName("Account:")).toBe("");
  });

  it("handles empty string", () => {
    expect(getAccountShortName("")).toBe("");
  });

  it("handles account with colon in the middle and end", () => {
    expect(getAccountShortName("Parent:Child:")).toBe("");
  });

  it("preserves short name with special characters", () => {
    expect(getAccountShortName("Parent:Child-Name (Special)")).toBe("Child-Name (Special)");
  });
});

describe("resolveAmountOnBlur", () => {
  it("formats a plain number to two decimal places", () => {
    expect(resolveAmountOnBlur("5")).toBe("5.00");
  });

  it("formats a decimal to two places", () => {
    expect(resolveAmountOnBlur("3.5")).toBe("3.50");
  });

  it("evaluates an addition expression", () => {
    expect(resolveAmountOnBlur("100+50")).toBe("150.00");
  });

  it("evaluates a division expression", () => {
    expect(resolveAmountOnBlur("85.40/2")).toBe("42.70");
  });

  it("evaluates expression with parentheses", () => {
    expect(resolveAmountOnBlur("(100+50)*2")).toBe("300.00");
  });

  it("returns original string for invalid expression", () => {
    expect(resolveAmountOnBlur("abc")).toBe("abc");
  });

  it("returns original string for empty input", () => {
    expect(resolveAmountOnBlur("")).toBe("");
  });

  it("formats zero to two decimal places", () => {
    expect(resolveAmountOnBlur("0")).toBe("0.00");
  });

  it("handles expression that evaluates to zero", () => {
    expect(resolveAmountOnBlur("5-5")).toBe("0.00");
  });

  it("handles currency-formatted input", () => {
    expect(resolveAmountOnBlur("$1,234.56")).toBe("1234.56");
  });

  it("handles negative result", () => {
    expect(resolveAmountOnBlur("5-10")).toBe("-5.00");
  });

  it("formats leading-decimal input like .5", () => {
    expect(resolveAmountOnBlur(".5")).toBe("0.50");
  });

  it("formats trailing-decimal input like 5.", () => {
    expect(resolveAmountOnBlur("5.")).toBe("5.00");
  });

  it("formats whitespace-padded number", () => {
    expect(resolveAmountOnBlur("  42  ")).toBe("42.00");
  });
});

describe("formatRelativeAge", () => {
  const MIN = 60_000;
  const HR = 60 * MIN;
  const DAY = 24 * HR;

  it("reports anything under a minute as just now", () => {
    expect(formatRelativeAge(0)).toBe("just now");
    expect(formatRelativeAge(59_000)).toBe("just now");
  });

  it("reports whole minutes under an hour", () => {
    expect(formatRelativeAge(MIN)).toBe("1 min ago");
    expect(formatRelativeAge(14 * MIN)).toBe("14 min ago");
    expect(formatRelativeAge(HR - 1000)).toBe("59 min ago");
  });

  it("reports whole hours under a day", () => {
    expect(formatRelativeAge(HR)).toBe("1 hr ago");
    expect(formatRelativeAge(3 * HR)).toBe("3 hr ago");
    expect(formatRelativeAge(DAY - 1000)).toBe("23 hr ago");
  });

  it("reports days beyond that, singular at one", () => {
    expect(formatRelativeAge(DAY)).toBe("1 day ago");
    expect(formatRelativeAge(2 * DAY)).toBe("2 days ago");
    expect(formatRelativeAge(11 * DAY)).toBe("11 days ago");
  });

  it("clamps a negative age to just now", () => {
    // Clock skew between the container that wrote the timestamp and the
    // browser reading it must not render "-1 days ago".
    expect(formatRelativeAge(-5000)).toBe("just now");
  });

  it("returns a dash for a non-finite age", () => {
    // An unparseable timestamp yields NaN; "NaN days ago" must never render.
    expect(formatRelativeAge(NaN)).toBe("—");
    expect(formatRelativeAge(Infinity)).toBe("—");
  });
});

describe("formatPriceMicrosInput", () => {
  it("writes a whole-dollar price with cents", () => {
    expect(formatPriceMicrosInput(1_000_000)).toBe("1.00");
  });

  it("keeps precision beyond cents", () => {
    // A NAV like 1.0025 is a real fixed price; rounding it to 1.00 changes
    // what the security is worth.
    expect(formatPriceMicrosInput(1_002_500)).toBe("1.0025");
  });

  it("keeps full micro precision when the price carries it", () => {
    expect(formatPriceMicrosInput(1_234_567)).toBe("1.234567");
  });
});
