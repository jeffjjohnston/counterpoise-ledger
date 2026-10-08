"use client";

import { cn } from "@/lib/utils";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

interface DateInputProps {
  label?: string;
  /**
   * Render the label as screen-reader-only text. For a field sitting under a
   * column header that already names it -- the register's quick-entry row --
   * where repeating the name on screen is noise but the accessible name is
   * still required.
   */
  labelHidden?: boolean;
  id?: string;
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  required?: boolean;
  size?: "default" | "compact";
  dropUp?: boolean;
  className?: string;
}

/** The width of the calendar, `w-[17rem]`, in pixels. */
const CALENDAR_WIDTH = 272;

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
// The column headers are abbreviated to fit the cell. Assistive tech gets
// the whole word instead.
const FULL_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function toYMD(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function parseYMD(s: string): { year: number; month: number; day: number } | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2] - 1, day: +m[3] };
}

function parseMDY(s: string): { year: number; month: number; day: number } | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = +m[1], day = +m[2], year = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  // Validate day is within the month
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;
  return { year, month: month - 1, day };
}

// Arrow keys move the highlight by whole days; Page Up/Down by whole months.
const DAY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};
const MONTH_STEPS: Record<string, number> = { PageUp: -1, PageDown: 1 };

function shiftDays(ymd: string, days: number): string {
  const p = parseYMD(ymd);
  if (!p) return ymd;
  // The local-time Date constructor rolls month and year over for us.
  const d = new Date(p.year, p.month, p.day + days);
  return toYMD(d.getFullYear(), d.getMonth(), d.getDate());
}

function shiftMonths(ymd: string, months: number): string {
  const p = parseYMD(ymd);
  if (!p) return ymd;
  const target = new Date(p.year, p.month + months, 1);
  // Clamp into the target month, so Jan 31 steps to Feb 28 rather than Mar 3.
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return toYMD(target.getFullYear(), target.getMonth(), Math.min(p.day, lastDay));
}

function todayYMD(): string {
  const now = new Date();
  return toYMD(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatMDY(value: string): string {
  const p = parseYMD(value);
  if (!p) return value;
  return `${pad(p.month + 1)}/${pad(p.day)}/${p.year}`;
}

// What a screen reader reads for a day cell. Built from MONTHS rather than
// toLocaleDateString so the announcement does not follow the host locale.
function fullDateLabel(ymd: string): string {
  const p = parseYMD(ymd);
  if (!p) return ymd;
  return `${MONTHS[p.month]} ${p.day}, ${p.year}`;
}

export function DateInput({
  label,
  labelHidden,
  id,
  value,
  onChange,
  required,
  size = "default",
  dropUp = false,
  className,
}: DateInputProps) {
  const isCompact = size === "compact";
  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState(() => formatMDY(value));
  const [editing, setEditing] = useState(false);
  // The day the arrow keys are sitting on. Non-null means the field is in
  // calendar-navigation mode: arrow keys move this highlight instead of the
  // caret, and nothing is committed until Enter. Null means plain text entry.
  const [navDate, setNavDate] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set on mousedown when the field is not yet focused, so the click that
  // follows can tell "the click that opened the calendar" from a later click
  // asking for a caret.
  const pointerFocusRef = useRef(false);
  // aria-controls and aria-activedescendant need ids, and a page can hold
  // several of these fields, so they cannot be derived from the id prop --
  // which is optional besides.
  const reactId = useId();
  const gridId = `date-input-grid-${reactId}`;
  const dayCellId = (ymd: string) => `date-input-day-${reactId}-${ymd}`;

  const parsed = parseYMD(value);
  const [viewYear, setViewYear] = useState(parsed?.year ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? new Date().getMonth());

  // Sync input text and calendar view when value changes externally (not while user is typing)
  useEffect(() => {
    if (editing) return;
    setInputText(formatMDY(value));
    const p = parseYMD(value);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month);
    }
  }, [value, editing]);

  // The calendar opens at the left edge of the field. When it would go past
  // the right edge of the screen, for example for a field in the right column
  // on a phone, it opens at the right edge of the field. The layout effect
  // runs before the paint, so the calendar never shows in the wrong place.
  const [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const box = containerRef.current.getBoundingClientRect();
    setAlignRight(box.left + CALENDAR_WIDTH > window.innerWidth && box.right - CALENDAR_WIDTH >= 0);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
        setNavDate(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function prevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  }

  function selectDate(ymd: string) {
    setInputText(formatMDY(ymd));
    setEditing(false);
    setNavDate(null);
    onChange(ymd);
    setOpen(false);
    inputRef.current?.focus();
  }

  // Where arrow-key navigation starts: the current value, or today when the
  // field is empty or holds something unparseable.
  function navigationStart() {
    return parseYMD(value) ? value : todayYMD();
  }

  function moveHighlight(ymd: string) {
    setNavDate(ymd);
    setOpen(true);
    const p = parseYMD(ymd);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setNavDate(null);
      commitInput();
      return;
    }

    if (navDate === null) {
      // Text entry: Up/Down re-arms calendar navigation, so a field the user
      // clicked into twice is not a dead end for the keyboard.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveHighlight(navigationStart());
      }
      return;
    }

    const dayStep = DAY_STEPS[e.key];
    if (dayStep !== undefined) {
      e.preventDefault();
      moveHighlight(shiftDays(navDate, dayStep));
      return;
    }

    const monthStep = MONTH_STEPS[e.key];
    if (monthStep !== undefined) {
      e.preventDefault();
      moveHighlight(shiftMonths(navDate, monthStep));
      return;
    }

    // Enter only claims the keystroke once the highlight has actually moved.
    // Focusing the field opens the calendar on its own, so claiming it always
    // would stop Enter submitting a form the user never navigated in.
    if (e.key === "Enter" && navDate !== value) {
      e.preventDefault();
      selectDate(navDate);
    }
  }

  function handleFocus() {
    setOpen(true);
    setNavDate(navigationStart());
  }

  function handleMouseDown() {
    pointerFocusRef.current = document.activeElement !== inputRef.current;
  }

  function handleClick() {
    if (pointerFocusRef.current) {
      // The click that focused the field: leave the arrow keys on the calendar.
      pointerFocusRef.current = false;
      return;
    }
    // A later click is asking for a caret, so the arrow keys go back to the
    // text. Reopening the calendar is separate from that: picking a date
    // closes it and refocuses the field, so no further focus event can fire
    // and the mouse would otherwise have no way back in.
    setNavDate(null);
    setOpen(true);
  }

  // Build calendar grid
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = new Array(firstDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  // aria-activedescendant has to name a cell that exists. The highlight stays
  // put when the header arrows move the view, so it can fall outside the
  // month on screen -- and a dangling reference is worse than none.
  const navParsed = navDate ? parseYMD(navDate) : null;
  const highlightInView =
    navParsed !== null && navParsed.year === viewYear && navParsed.month === viewMonth;
  const activeDescendantId = open && navDate && highlightInView ? dayCellId(navDate) : undefined;

  function handleInputChange(text: string) {
    setInputText(text);
    setEditing(true);
    setNavDate(null);
    if (!open) setOpen(true);
    const p = parseMDY(text);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month);
      onChange(toYMD(p.year, p.month, p.day));
    }
  }

  function commitInput() {
    setEditing(false);
    setNavDate(null);
    const p = parseMDY(inputText);
    if (p) {
      onChange(toYMD(p.year, p.month, p.day));
    }
    // Reset display to the current value (fixes partial/invalid input)
    setInputText(formatMDY(value));
  }

  return (
    <div className="w-full relative" ref={containerRef}>
      {label && (
        <label
          htmlFor={id}
          className={
            labelHidden
              ? "sr-only"
              : cn(
                  "block",
                  isCompact
                    ? "text-xs font-medium text-fg-tertiary mb-0 leading-tight"
                    : "text-sm font-medium text-fg-secondary mb-1"
                )
          }
        >
          {label}
        </label>
      )}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-haspopup="grid"
        aria-expanded={open}
        aria-controls={open ? gridId : undefined}
        aria-activedescendant={activeDescendantId}
        value={inputText}
        placeholder="MM/DD/YYYY"
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={handleFocus}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onBlur={() => commitInput()}
        onKeyDown={handleKeyDown}
        required={required}
        className={cn(
          "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-hidden focus:ring-1 focus:ring-border-focus text-sm",
          isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2",
          className
        )}
      />
      {open && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          data-align={alignRight ? "right" : "left"}
          className={cn(
            "absolute z-50 bg-surface-elevated rounded-lg border border-border shadow-lg p-2 w-[17rem]",
            dropUp ? "bottom-full mb-1" : "mt-1",
            alignRight && "right-0"
          )}
        >
          {/* Header: prev / month year / next */}
          <div className="flex items-center justify-between mb-1">
            <button
              type="button"
              onClick={prevMonth}
              className="p-1 hover:bg-surface-tertiary rounded-md text-fg-secondary"
              aria-label="Previous month"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-sm font-medium text-fg">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              className="p-1 hover:bg-surface-tertiary rounded-md text-fg-secondary"
              aria-label="Next month"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          {/* Calendar grid. Each week carries its own seven-column layout so the
              DOM can nest grid > row > gridcell without a display:contents row
              wrapper, which browsers have historically dropped from the
              accessibility tree. There is no row gap, so the weeks still stack
              flush the way one tall grid did. */}
          <div role="grid" id={gridId} aria-label={`${MONTHS[viewMonth]} ${viewYear}`}>
            <div role="row" className="grid grid-cols-7 text-center mb-0.5">
              {DAYS.map((d, i) => (
                <div
                  key={d}
                  role="columnheader"
                  aria-label={FULL_DAYS[i]}
                  className="text-[10px] font-medium text-fg-tertiary py-0.5"
                >
                  {d}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} role="row" className="grid grid-cols-7 text-center">
                {week.map((day, di) => {
                  // The padding either side of the month is still a cell, so
                  // every row a screen reader walks is a full seven days wide.
                  if (day === null) return <div key={di} role="gridcell" />;
                  const dateStr = toYMD(viewYear, viewMonth, day);
                  const isSelected = dateStr === value;
                  const isHighlighted = dateStr === navDate;
                  const isToday =
                    dateStr ===
                    toYMD(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
                  return (
                    // The cell and the control the user activates are one
                    // element on purpose: aria-activedescendant, aria-selected
                    // and the accessible name then describe the same node, so a
                    // day reads the same however it is reached. tabIndex -1
                    // keeps focus in the input, which is what names the active
                    // day; a tab stop per day would contradict that.
                    <button
                      key={di}
                      type="button"
                      role="gridcell"
                      id={dayCellId(dateStr)}
                      aria-label={fullDateLabel(dateStr)}
                      aria-selected={isSelected}
                      tabIndex={-1}
                      onClick={() => selectDate(dateStr)}
                      data-highlighted={isHighlighted ? "true" : undefined}
                      className={cn(
                        "text-xs py-1 rounded-md hover:bg-accent-subtle",
                        isSelected && "bg-accent text-fg-on-accent hover:bg-accent-hover",
                        !isSelected && isToday && "font-bold text-fg-accent",
                        !isSelected && !isToday && "text-fg",
                        isHighlighted && "ring-2 ring-inset ring-border-focus"
                      )}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
