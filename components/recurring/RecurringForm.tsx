"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SplitEditor } from "@/components/transactions/SplitEditor";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { formatDate, formatDateShort, toDateString } from "@/lib/formatters";
import {
  describeRecurrence,
  validateSplits,
  type RecurrenceConfig,
} from "@/lib/accounting";
import {
  MAX_AUTO_CREATE_DAYS_BEFORE,
  maxIntervalFor,
  previewOccurrences,
  scheduleKey,
} from "@/lib/recurring";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type {
  AccountWithBalance,
  RecurringRuleWithSplits,
  SplitInput,
} from "@/types";

type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export type RecurringFormData = {
  name: string;
  frequency: Frequency;
  interval: number;
  daysOfWeek: number[] | null;
  weekOfMonth: string | null;
  daysOfMonth: number[] | null;
  startDate: string;
  endDate: string | null;
  /**
   * Only sent when the user has set it by hand. updateRecurringRule skips its
   * own recompute whenever a nextDate arrives, so sending it on every save
   * would freeze the date against schedule changes. Absent from
   * createRuleSchema — on create, Start Date already is the first occurrence.
   */
  nextDate?: string;
  autoCreateDaysBefore: number;
  businessDaysOnly: boolean;
  templateDescription: string;
  templateSplits: SplitInput[];
  payeeId: number | null;
  payeeName?: string;
};

// The unit select *is* the frequency; its labels agree in number with the
// interval beside it, so the row reads as one sentence.
const FREQUENCY_UNITS: Array<{ value: Frequency; one: string; many: string }> = [
  { value: "daily", one: "day", many: "days" },
  { value: "weekly", one: "week", many: "weeks" },
  { value: "monthly", one: "month", many: "months" },
  { value: "yearly", one: "year", many: "years" },
];

// The numeric values are written to weekOfMonth, which getNextDate() resolves
// through nthWeekdayInMonth() — "the 4th Tuesday of the month", a monthly
// cadence. They used to be labelled "Every 4th week", which promised a 28-day
// one; an every-N-weeks schedule is the interval control below. Wording tracks
// describeRecurrence() in lib/accounting.ts so the list and the form agree.
const WEEKLY_SCOPE_OPTIONS = [
  { value: "every", label: "Every week" },
  { value: "1", label: "1st week of each month" },
  { value: "2", label: "2nd week of each month" },
  { value: "3", label: "3rd week of each month" },
  { value: "4", label: "4th week of each month" },
  { value: "5", label: "5th week of each month" },
  { value: "last", label: "Last week of each month" },
];

/** A titled band of the form. The three of them are the whole grouping. */
function FormSection({
  title,
  first,
  children,
}: {
  title: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(!first && "border-t border-border-secondary pt-3")}>
      <h3 className="mb-2 text-sm font-semibold text-fg">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * A named group of toggle buttons. The label used to be a bare <label> with no
 * htmlFor and no control to point at, so it named nothing to a screen reader —
 * role="group" plus aria-labelledby is what actually gives the grid a name.
 */
function ToggleGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = `toggle-group-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id}>
      <span
        id={id}
        className="block text-sm font-medium text-fg-secondary mb-1.5"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export type PrefillData = {
  name: string;
  templateDescription: string;
  templateSplits: SplitInput[];
  payeeId?: number | null;
  payeeName?: string;
};

export function RecurringForm({
  rule,
  prefill,
  accounts,
  bookId,
  onSubmit,
  onCancel,
}: {
  rule?: RecurringRuleWithSplits;
  prefill?: PrefillData;
  accounts: AccountWithBalance[];
  bookId: string;
  onSubmit: (data: RecurringFormData) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(rule?.name || prefill?.name || "");
  const [payeeName, setPayeeName] = useState(
    rule?.payee?.name || prefill?.payeeName || ""
  );
  const [payeeId, setPayeeId] = useState<number | null>(
    rule?.payeeId ?? prefill?.payeeId ?? null
  );
  const [payeeSuggestions, setPayeeSuggestions] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [frequency, setFrequency] = useState<Frequency>(
    (rule?.frequency as Frequency) || "monthly"
  );
  const [intervalVal, setIntervalVal] = useState(rule?.interval ?? 1);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(
    rule?.daysOfWeek ? JSON.parse(rule.daysOfWeek) : []
  );
  const [weekOfMonth, setWeekOfMonth] = useState(rule?.weekOfMonth || "every");
  const [daysOfMonth, setDaysOfMonth] = useState<number[]>(
    rule?.daysOfMonth ? JSON.parse(rule.daysOfMonth) : []
  );
  const [nextDateOverride, setNextDateOverride] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [startDate, setStartDate] = useState(
    rule?.startDate || toDateString(new Date())
  );
  const [endDate, setEndDate] = useState(rule?.endDate || "");
  const [autoCreateDaysBefore, setAutoCreateDaysBefore] = useState(
    rule?.autoCreateDaysBefore ?? 0
  );
  const [businessDaysOnly, setBusinessDaysOnly] = useState(
    rule?.businessDaysOnly ?? false
  );
  const [description, setDescription] = useState(rule?.templateDescription || prefill?.templateDescription || "");
  const [splits, setSplits] = useState<SplitInput[]>(
    rule?.templateSplits.map((s) => ({
      accountId: s.accountId,
      amount: s.amount,
    })) || prefill?.templateSplits || [
      { accountId: accounts[0]?.id || 0, amount: 0 },
      { accountId: accounts[1]?.id || 0, amount: 0 },
    ]
  );

  const toggleDayOfWeek = (day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const toggleDayOfMonth = (day: number) => {
    setDaysOfMonth((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => {
        if (a === -1) return 1;
        if (b === -1) return -1;
        return a - b;
      })
    );
  };

  useEffect(() => {
    const query = payeeName.trim();
    if (!query) {
      setPayeeSuggestions([]);
      setPayeeId(null);
      return;
    }

    const controller = new AbortController();

    const fetchSuggestions = async () => {
      try {
        const data = await apiGet<Array<{ id: number; name: string }>>(
          `/api/b/${bookId}/payees?search=${encodeURIComponent(query)}&limit=8`,
          { signal: controller.signal }
        );
        const suggestions = Array.isArray(data) ? data : [];
        setPayeeSuggestions(suggestions);
        const match = suggestions.find(
          (p: { name: string }) => p.name.toLowerCase() === query.toLowerCase()
        );
        setPayeeId(match ? match.id : null);
      } catch (error) {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    };

    // setTimeout requires a void-returning callback; fetchSuggestions
    // already catches its own errors (including abort), so this is a
    // safe fire-and-forget.
    const timeout = setTimeout(() => {
      void fetchSuggestions();
    }, 150);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [payeeName, bookId]);

  // What the controls above actually add up to. Until this existed the form
  // asked for four to six schedule inputs and rendered no answer, so a
  // mis-set schedule looked exactly like a correct one — the reason all three
  // schedule defects fixed alongside this preview were invisible here and
  // obvious in the rule list one screen away.
  // getNextDate reads interval only in its weekly "every" branch, so an
  // nth-week-of-month pattern must not appear to carry one.
  const intervalIgnored = frequency === "weekly" && weekOfMonth !== "every";

  const previewConfig = useMemo<RecurrenceConfig>(
    () => ({
      frequency,
      interval: Math.max(1, intervalVal),
      daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : undefined,
      weekOfMonth: frequency === "weekly" ? weekOfMonth : undefined,
      daysOfMonth: daysOfMonth.length > 0 ? daysOfMonth : undefined,
    }),
    [frequency, intervalVal, daysOfWeek, weekOfMonth, daysOfMonth]
  );

  // An edit that leaves the schedule alone keeps the rule's stored nextDate
  // (updateRecurringRule compares the same scheduleKey), so the preview has to
  // start there. Re-deriving from startDate regardless would show a cadence
  // the save will not produce.
  const seed = useMemo(() => {
    if (nextDateOverride) return nextDateOverride;
    if (!rule) return undefined;
    const stored = scheduleKey({
      frequency: rule.frequency as RecurrenceConfig["frequency"],
      interval: rule.interval,
      daysOfWeek: rule.daysOfWeek ? JSON.parse(rule.daysOfWeek) : undefined,
      weekOfMonth: rule.weekOfMonth ?? undefined,
      daysOfMonth: rule.daysOfMonth ? JSON.parse(rule.daysOfMonth) : undefined,
    });
    const unchanged =
      stored === scheduleKey(previewConfig) && startDate === rule.startDate;
    return unchanged ? rule.nextDate : undefined;
  }, [rule, previewConfig, startDate, nextDateOverride]);

  const previewDates = useMemo(
    () =>
      startDate
        ? previewOccurrences({
            config: previewConfig,
            startDate,
            businessDaysOnly,
            seed,
            count: 3,
          })
        : [],
    [previewConfig, startDate, businessDaysOnly, seed]
  );

  const previewSpansYears = previewDates.some(
    (date) => date.slice(0, 4) !== previewDates[0].slice(0, 4)
  );

  const recurrenceText = describeRecurrence({
    frequency,
    interval: Math.max(1, intervalVal),
    daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : null,
    weekOfMonth: frequency === "weekly" ? weekOfMonth : null,
    daysOfMonth: daysOfMonth.length > 0 ? daysOfMonth : null,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateSplits(splits)) {
      toast.error("Splits must be balanced (debits = credits)");
      return;
    }

    const normalizedPayeeName = payeeName.trim();

    onSubmit({
      name,
      frequency,
      // intervalVal is reset to 1 whenever the frequency changes and is only
      // edited by controls that are actually on screen, so sending it as-is
      // preserves a weekly rule's "every N weeks" instead of flattening it to
      // 1 — which is what silently turned an every-4-weeks rule into a weekly
      // one every time this form was saved.
      interval: intervalVal,
      daysOfWeek: frequency === "weekly" && daysOfWeek.length > 0 ? daysOfWeek : null,
      weekOfMonth: frequency === "weekly" ? weekOfMonth : null,
      daysOfMonth: frequency === "monthly" && daysOfMonth.length > 0 ? daysOfMonth : null,
      startDate,
      endDate: endDate || null,
      // undefined is dropped by JSON.stringify, so an untouched field sends no
      // key at all and the server recompute stays in charge.
      nextDate: nextDateOverride ?? undefined,
      autoCreateDaysBefore,
      businessDaysOnly,
      templateDescription: description,
      templateSplits: splits,
      payeeId: normalizedPayeeName ? payeeId : null,
      payeeName: normalizedPayeeName || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Three jobs, three groups. Nine top-level fields used to share one
          undifferentiated column, which is most of why the card ran ~1170px
          inside a 672px sheet capped at 90vh. */}
      <FormSection title="What it is" first>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Rule Name"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Monthly Rent"
            required
          />
          <PayeeAutocomplete
            label="Payee"
            payees={payeeSuggestions}
            textValue={payeeName}
            onTextChange={setPayeeName}
            placeholder="e.g., Landlord"
          />
        </div>
        {/* Both fields are plain text and often hold the same words, and a
            placeholder disappears the moment either is filled — which for an
            existing rule is always. The suffix costs no vertical space. */}
        <Input
          label="Description"
          labelSuffix="appears on each transaction"
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g., Rent payment to landlord"
        />
      </FormSection>

      <FormSection title="When it runs">
        <div className="grid grid-cols-2 gap-4">
          {/* One interval control for every frequency. Daily and weekly each
              had their own number input, monthly had a six-preset dropdown
              that put every 7 months out of reach, and yearly had nothing. */}
          <div>
            <label
              htmlFor="interval"
              className="block text-sm font-medium text-fg-secondary mb-1"
            >
              Repeat every
            </label>
            {/* Input and Select each render a w-full wrapper, so the widths go
                on the flex children rather than the controls. */}
            <div className="flex items-center gap-2">
              <div className="w-20 shrink-0">
                <Input
                  id="interval"
                  type="number"
                  min={1}
                  max={maxIntervalFor(frequency)}
                  value={intervalVal}
                  selectOnFocus
                  disabled={intervalIgnored}
                  onChange={(e) =>
                    setIntervalVal(
                      Math.min(
                        maxIntervalFor(frequency),
                        Math.max(1, parseInt(e.target.value, 10) || 1)
                      )
                    )
                  }
                />
              </div>
              <div className="flex-1">
                <Select
                  id="frequency"
                  aria-label="Frequency"
                  value={frequency}
                  onChange={(e) => {
                    const f = e.target.value as Frequency;
                    setFrequency(f);
                    setIntervalVal(1);
                    setDaysOfWeek([]);
                    setWeekOfMonth("every");
                    setDaysOfMonth([]);
                  }}
                  options={FREQUENCY_UNITS.map((u) => ({
                    value: u.value,
                    label: intervalVal === 1 ? u.one : u.many,
                  }))}
                />
              </div>
            </div>
          </div>

          {frequency === "weekly" && (
            /* Was "Week Pattern", which read as a sibling of the old "Month
               Pattern" while writing a different column entirely. */
            <Select
              label="Which weeks"
              id="weekOfMonth"
              value={weekOfMonth}
              onChange={(e) => {
                const wom = e.target.value;
                setWeekOfMonth(wom);
                // getNextDate() reads interval only in its "every" branch, so
                // an nth-week-of-month pattern must not carry a stale one.
                if (wom !== "every") setIntervalVal(1);
              }}
              options={WEEKLY_SCOPE_OPTIONS}
            />
          )}

          {!rule && (
            <Input
              type="date"
              label="Starts on"
              id="startDate"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          )}
        </div>

        {frequency === "weekly" && intervalIgnored && (
          <p className="-mt-1 text-xs text-fg-tertiary">
            An nth-week pattern repeats once a month, so the interval does not
            apply.
          </p>
        )}

        {frequency === "weekly" && (
          <ToggleGroup label="Days of Week">
            <div className="flex gap-1.5">
              {DAY_LABELS.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={daysOfWeek.includes(i)}
                  onClick={() => toggleDayOfWeek(i)}
                  className={cn(
                    "w-9 h-9 rounded-lg text-sm font-medium transition-colors",
                    daysOfWeek.includes(i)
                      ? "bg-accent text-fg-on-accent"
                      : "bg-surface-tertiary text-fg-secondary hover:bg-surface-tertiary"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </ToggleGroup>
        )}

        {frequency === "monthly" && (
          <ToggleGroup label="Days of Month">
            <div className="grid grid-cols-7 gap-1.5">
              {/* Stops at 30: day 31 clamps to the last day of every month, so
                  a "31" button would be an exact duplicate of "Last" below. */}
              {Array.from({ length: 30 }, (_, i) => i + 1).map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={daysOfMonth.includes(day)}
                  onClick={() => toggleDayOfMonth(day)}
                  className={cn(
                    "h-8 rounded text-sm font-medium transition-colors",
                    daysOfMonth.includes(day)
                      ? "bg-accent text-fg-on-accent"
                      : "bg-surface-tertiary text-fg-secondary hover:bg-surface-tertiary"
                  )}
                >
                  {day}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={daysOfMonth.includes(-1)}
                onClick={() => toggleDayOfMonth(-1)}
                className={cn(
                  "h-8 rounded text-xs font-medium transition-colors col-span-2",
                  daysOfMonth.includes(-1)
                    ? "bg-accent text-fg-on-accent"
                    : "bg-surface-tertiary text-fg-secondary hover:bg-surface-tertiary"
                )}
              >
                Last
              </button>
            </div>
          </ToggleGroup>
        )}

        {previewDates.length > 0 && (
          <div
            data-testid="schedule-summary"
            className="rounded-md bg-accent-subtle px-3 py-2.5"
          >
            <p className="text-sm font-medium text-fg-accent">{recurrenceText}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-secondary">
              {rule ? (
                <>
                  <label htmlFor="nextDate">Next occurrence</label>
                  <input
                    type="date"
                    id="nextDate"
                    value={nextDateOverride ?? previewDates[0] ?? ""}
                    onChange={(e) => setNextDateOverride(e.target.value || null)}
                    className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-fg focus:border-border-focus focus:outline-hidden focus:ring-1 focus:ring-border-focus"
                  />
                </>
              ) : (
                <span>Next: {formatDate(previewDates[0])}</span>
              )}
              {previewDates.length > 1 && (
                <span>
                  then{" "}
                  {previewDates
                    .slice(1)
                    // formatDateShort drops the year, which renders a yearly
                    // rule's three distinct dates as the same string. Keep the
                    // year whenever the preview crosses one.
                    .map(previewSpansYears ? formatDate : formatDateShort)
                    .join(" \u00b7 ")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Closed by default: these four are in the path of every routine edit
            and almost never the reason for one. */}
        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1.5 py-1 text-sm text-fg-secondary hover:text-fg"
          >
            <svg
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                advancedOpen && "rotate-90"
              )}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            Advanced
          </button>

          {advancedOpen && (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                {rule && (
                  <div>
                    <Input
                      type="date"
                      label="Anchor date"
                      id="startDate"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      required
                    />
                    <p className="mt-1 text-xs text-fg-tertiary">
                      The schedule counts from here. Changing it re-times every
                      future occurrence.
                    </p>
                  </div>
                )}
                <Input
                  type="date"
                  label="End date (optional)"
                  id="endDate"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>

              <div>
                <label
                  htmlFor="autoCreateDaysBefore"
                  className="block text-sm font-medium text-fg-secondary mb-1"
                >
                  Create it early
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-20 shrink-0">
                    <Input
                      id="autoCreateDaysBefore"
                      type="number"
                      min={0}
                      max={MAX_AUTO_CREATE_DAYS_BEFORE}
                      value={autoCreateDaysBefore}
                      selectOnFocus
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        const nextValue = Number.isNaN(parsed) ? 0 : parsed;
                        setAutoCreateDaysBefore(
                          Math.min(
                            MAX_AUTO_CREATE_DAYS_BEFORE,
                            Math.max(0, nextValue)
                          )
                        );
                      }}
                    />
                  </div>
                  <span className="text-sm text-fg-secondary">
                    days before it is due
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="businessDaysOnly"
                  className="flex items-center gap-2 text-sm text-fg"
                >
                  <input
                    type="checkbox"
                    id="businessDaysOnly"
                    checked={businessDaysOnly}
                    onChange={(e) => setBusinessDaysOnly(e.target.checked)}
                    className="h-4 w-4 text-fg-accent focus:ring-fg-accent border-border rounded"
                  />
                  <span>Business days only</span>
                </label>
                <p className="pl-6 text-xs text-fg-tertiary">
                  An occurrence that falls on a weekend is created on the next
                  business day instead. The schedule itself does not move.
                </p>
              </div>
            </div>
          )}
        </div>
      </FormSection>

      <FormSection title="What it posts">
        <SplitEditor
          splits={splits}
          onChange={setSplits}
          accounts={accounts.filter((a) => a.isActive)}
        />
      </FormSection>

      {/* Pinned to the bottom of the scrolling sheet. Grouping the fields cut
          the form's own height from roughly 700px to 500px, but the splits
          editor grows with the transaction — an eight-split paycheck is 469px
          on its own — so a large rule will always exceed the sheet and the
          actions have to stay reachable rather than merely fit. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-3 border-t border-border bg-surface-elevated px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{rule ? "Save Changes" : "Create Rule"}</Button>
      </div>
    </form>
  );
}
