"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

interface DateInputProps {
  label?: string;
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

function formatMDY(value: string): string {
  const p = parseYMD(value);
  if (!p) return value;
  return `${pad(p.month + 1)}/${pad(p.day)}/${p.year}`;
}

export function DateInput({
  label,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  function selectDay(day: number) {
    const ymd = toYMD(viewYear, viewMonth, day);
    setInputText(formatMDY(ymd));
    setEditing(false);
    onChange(ymd);
    setOpen(false);
    inputRef.current?.focus();
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
          className={cn(
            "block",
            isCompact
              ? "text-xs font-medium text-fg-tertiary mb-0 leading-tight"
              : "text-sm font-medium text-fg-secondary mb-1"
          )}
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
        onFocus={() => setOpen(true)}
        onBlur={() => commitInput()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            commitInput();
          }
        }}
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
              const isToday =
                dateStr === toYMD(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectDay(day)}
                  className={cn(
                    "text-xs py-1 rounded-md hover:bg-accent-subtle",
                    isSelected && "bg-accent text-fg-on-accent hover:bg-accent-hover",
                    !isSelected && isToday && "font-bold text-fg-accent",
                    !isSelected && !isToday && "text-fg"
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
