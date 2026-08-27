"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

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

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
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
          "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
          isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2",
          className
        )}
      />
      {open && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            "absolute z-50 bg-surface-elevated rounded-lg border border-border shadow-lg p-2 w-[17rem]",
            dropUp ? "bottom-full mb-1" : "mt-1"
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
          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 text-center mb-0.5">
            {DAYS.map((d) => (
              <div key={d} className="text-[10px] font-medium text-fg-tertiary py-0.5">
                {d}
              </div>
            ))}
          </div>
          {/* Calendar grid */}
          <div className="grid grid-cols-7 text-center">
            {weeks.flat().map((day, i) => {
              if (day === null) return <div key={i} />;
              const dateStr = toYMD(viewYear, viewMonth, day);
              const isSelected = dateStr === value;
              const isHighlighted = dateStr === navDate;
              const isToday =
                dateStr === toYMD(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
              return (
                <button
                  key={i}
                  type="button"
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
        </div>
      )}
    </div>
  );
}
