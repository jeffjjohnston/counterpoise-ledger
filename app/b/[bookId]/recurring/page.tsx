"use client";

import { useEffect, useState, Suspense, useCallback, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SplitEditor } from "@/components/transactions/SplitEditor";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { formatCurrency, formatDate, toDateString, getAccountShortName } from "@/lib/formatters";
import {
  describeRecurrence,
  validateSplits,
  flattenAccounts,
  getNextDate,
  type RecurrenceConfig,
} from "@/lib/accounting";
import {
  getOccurrenceDate,
  isRecurringRuleDue,
  MAX_AUTO_CREATE_DAYS_BEFORE,
  MAX_DAILY_INTERVAL_DAYS,
} from "@/lib/recurring";
import { useSearchParams, useRouter } from "next/navigation";
import { cn, selectInputContents } from "@/lib/utils";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type {
  AccountWithBalance,
  RecurringRuleWithSplits,
  SplitInput,
  TransactionWithSplits,
} from "@/types";

type CalendarDay = {
  date: string;
  dayNumber: number;
  monthLabel: string;
  isToday: boolean;
  isPast: boolean;
};

type CalendarOccurrence = {
  ruleId: number;
  ruleName: string;
  type: "scheduled" | "completed";
};

type RecurringTransaction = {
  transactionId: number;
  date: string;
  recurringRuleId: number;
  ruleName: string;
};

const CALENDAR_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_WEEKS = 4;
const DAYS_PER_WEEK = 7;
const MAX_OCCURRENCE_ITERATIONS = 366;
const DELETE_EXIT_ANIMATION_MS = 320;

function parseDateString(dateString: string): Date {
  return new Date(`${dateString}T00:00:00`);
}

type ProcessResult = {
  transactionsCreated: number;
  skipped?: Array<{ ruleId: number; reason: string }>;
};

/**
 * Describes what processing actually did.
 *
 * "Created 0 transaction(s)" is true but useless for a malformed rule: the rule
 * is deliberately left due so it stays visible, so the user clicks again, gets
 * the same message, and never learns why. A skipped rule reports its reason.
 */
function describeProcessResult(data: ProcessResult): string {
  const created = `Created ${data.transactionsCreated} transaction(s)`;
  if (!data.skipped?.length) return created;

  const reasons = data.skipped.map((s) => `rule ${s.ruleId}: ${s.reason}`).join("\n");
  return `${created}\n\nSkipped ${data.skipped.length} rule(s) — these stay due until fixed:\n${reasons}`;
}

function buildRuleRecurrenceConfig(rule: RecurringRuleWithSplits): RecurrenceConfig {
  const parseDays = (value: string | null): number[] | undefined => {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    frequency: rule.frequency as RecurrenceConfig["frequency"],
    interval: Math.max(1, rule.interval ?? 1),
    daysOfWeek: parseDays(rule.daysOfWeek),
    weekOfMonth: rule.weekOfMonth || undefined,
    daysOfMonth: parseDays(rule.daysOfMonth),
  };
}

function getRuleOccurrencesInRange(
  rule: RecurringRuleWithSplits,
  rangeStartDate: string,
  rangeEndDate: string,
  today: string
): string[] {
  if (!rule.isActive) return [];

  const config = buildRuleRecurrenceConfig(rule);
  const occurrences: string[] = [];
  let iterations = 0;
  let currentDate = rule.nextDate;

  // The walk follows the scheduled dates; every date that leaves this function
  // is the observed one, so a businessDaysOnly rule lands on the calendar
  // square the transaction will actually carry.
  const observe = (date: string) => getOccurrenceDate(date, rule.businessDaysOnly);

  while (observe(currentDate) < rangeStartDate && iterations < MAX_OCCURRENCE_ITERATIONS) {
    const nextDate = getNextDate(currentDate, config);
    if (nextDate <= currentDate) break;
    currentDate = nextDate;
    iterations++;
  }

  while (currentDate <= rangeEndDate && iterations < MAX_OCCURRENCE_ITERATIONS) {
    const occurrenceDate = observe(currentDate);
    if (occurrenceDate > today && occurrenceDate <= rangeEndDate) {
      occurrences.push(occurrenceDate);
    }

    const nextDate = getNextDate(currentDate, config);
    if (nextDate <= currentDate) break;
    currentDate = nextDate;
    iterations++;
  }

  return occurrences;
}

function RecurringPageInner() {
  const bookId = useBookId();
  const toast = useToast();
  const [rules, setRules] = useState<RecurringRuleWithSplits[]>([]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [completedTxns, setCompletedTxns] = useState<RecurringTransaction[]>([]);
  const [deletingRuleIds, setDeletingRuleIds] = useState<number[]>([]);
  const [exitingRuleIds, setExitingRuleIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurringRuleWithSplits | null>(
    null
  );
  const [prefillData, setPrefillData] = useState<PrefillData | undefined>(undefined);
  const [highlightRuleId, setHighlightRuleId] = useState<number | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const highlightedRef = useRef<HTMLDivElement>(null);
  const removeRuleTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  const fetchData = useCallback(async (showLoading: boolean) => {
    // Compute calendar date range for the recurring transactions query
    const now = new Date();
    const todayStr = toDateString(now);
    const calStart = new Date(`${todayStr}T00:00:00`);
    calStart.setDate(calStart.getDate() - calStart.getDay());
    const calEnd = new Date(calStart);
    calEnd.setDate(calStart.getDate() + CALENDAR_WEEKS * DAYS_PER_WEEK - 1);

    try {
      const [rulesData, accountsData, txnsData] = await Promise.all([
        apiGet<RecurringRuleWithSplits[]>(`/api/b/${bookId}/recurring`),
        apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts?includeInactive=true`),
        apiGet<RecurringTransaction[]>(
          `/api/b/${bookId}/recurring/transactions?startDate=${toDateString(calStart)}&endDate=${toDateString(calEnd)}`
        ),
      ]);

      // rulesData drives `rules.filter(...)` below on every render; an
      // unexpected (non-array) shape must fail loudly here rather than
      // throwing later, outside this try/catch, when the page renders.
      if (!Array.isArray(rulesData)) {
        throw new Error("Unexpected response shape for recurring rules");
      }

      // Flatten accounts
      const flatAccounts = flattenAccounts(accountsData);

      setRules(rulesData);
      setAccounts(flatAccounts);
      setCompletedTxns(Array.isArray(txnsData) ? txnsData : []);
      setError(null);
    } catch {
      if (showLoading) {
        // Nothing has rendered yet — the full-page error state is correct.
        setError("Could not load recurring rules.");
      } else {
        // A background refresh (after processing/deleting/toggling a rule,
        // or creating/editing one) failed. The already-rendered rules and
        // calendar are still correct, so keep them on screen and surface
        // the failure without blanking the page.
        toast.error("Could not refresh recurring rules.");
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [bookId, toast]);

  useEffect(() => {
    // fetchData handles its own errors internally.
    void fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    const highlightParam = searchParams.get("highlightRule");
    if (!highlightParam) return;
    const ruleId = parseInt(highlightParam, 10);
    if (!Number.isFinite(ruleId)) return;

    setHighlightRuleId(ruleId);

    // Scroll to the highlighted rule once data is loaded
    const timer = setTimeout(() => {
      highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);

    // Clear highlight after animation
    const clearTimer = setTimeout(() => {
      setHighlightRuleId(null);
      window.history.replaceState(null, "", `/b/${bookId}/recurring`);
    }, 2000);

    return () => {
      clearTimeout(timer);
      clearTimeout(clearTimer);
    };
  }, [searchParams, router, bookId]);

  useEffect(() => {
    const fromTransaction = searchParams.get("fromTransaction");
    if (!fromTransaction) return;
    const transactionId = parseInt(fromTransaction, 10);
    if (!Number.isFinite(transactionId)) return;

    let cancelled = false;

    // Fire-and-forget: the try/catch below already swallows every failure
    // (network, parsing, or an unmount race via `cancelled`), so there is
    // nothing further to await or handle here.
    void (async () => {
      try {
        const txn = await apiGet<TransactionWithSplits>(
          `/api/b/${bookId}/transactions/${transactionId}`
        );
        if (cancelled) return;

        const name = txn.payee?.name || txn.description || "";
        const templateDescription = txn.description || "";
        const templateSplits: SplitInput[] = (txn.splits || []).map((s) => ({
          accountId: s.accountId,
          amount: s.amount,
        }));

        setPrefillData({
          name,
          templateDescription,
          templateSplits,
          payeeId: txn.payeeId ?? null,
          payeeName: txn.payee?.name || "",
        });
        setShowModal(true);
      } catch {
        // If fetch fails, just open the page normally
      }
    })();

    return () => { cancelled = true; };
  }, [bookId, searchParams]);

  useEffect(() => {
    return () => {
      for (const timeoutId of removeRuleTimeouts.current) {
        clearTimeout(timeoutId);
      }
      removeRuleTimeouts.current = [];
    };
  }, []);

  const closeNewRuleModal = useCallback(() => {
    setShowModal(false);
    setPrefillData(undefined);
    if (searchParams.get("fromTransaction")) {
      router.replace(`/b/${bookId}/recurring`);
    }
  }, [router, searchParams, bookId]);

  const handleProcessRule = async (ruleId: number) => {
    try {
      const data = await apiPost<ProcessResult>(`/api/b/${bookId}/recurring/process`, {
        ruleId,
      });
      void fetchData(false);
      const message = describeProcessResult(data);
      if (data.skipped?.length) {
        toast.error(message);
      } else {
        toast.success(message);
      }
    } catch (e) {
      toast.error(toMessage(e, "Failed to process the rule"));
    }
  };

  const handleProcessAll = async () => {
    try {
      const data = await apiPost<ProcessResult>(`/api/b/${bookId}/recurring/process`, {
        processAll: true,
      });
      void fetchData(false);
      const message = describeProcessResult(data);
      if (data.skipped?.length) {
        toast.error(message);
      } else {
        toast.success(message);
      }
    } catch (e) {
      toast.error(toMessage(e, "Failed to process rules"));
    }
  };

  const handleDelete = async (id: number) => {
    if (deletingRuleIds.includes(id) || exitingRuleIds.includes(id)) return;
    if (!confirm("Are you sure you want to delete this recurring rule?")) return;

    setDeletingRuleIds((prev) => (prev.includes(id) ? prev : [...prev, id]));

    try {
      await apiDelete(`/api/b/${bookId}/recurring/${id}`);

      setExitingRuleIds((prev) => (prev.includes(id) ? prev : [...prev, id]));

      const timeoutId = setTimeout(() => {
        setRules((prev) => prev.filter((rule) => rule.id !== id));
        setCompletedTxns((prev) =>
          prev.filter((transaction) => transaction.recurringRuleId !== id)
        );
        setDeletingRuleIds((prev) => prev.filter((ruleId) => ruleId !== id));
        setExitingRuleIds((prev) => prev.filter((ruleId) => ruleId !== id));
        void fetchData(false);
        removeRuleTimeouts.current = removeRuleTimeouts.current.filter(
          (activeTimeoutId) => activeTimeoutId !== timeoutId
        );
      }, DELETE_EXIT_ANIMATION_MS);

      removeRuleTimeouts.current.push(timeoutId);
    } catch (e) {
      // The rule stays visible because the exit animation never started; tell
      // the user why it is still here.
      toast.error(toMessage(e, "Failed to delete recurring rule"));
    } finally {
      setDeletingRuleIds((prev) => prev.filter((ruleId) => ruleId !== id));
    }
  };

  const handleToggleActive = async (rule: RecurringRuleWithSplits) => {
    try {
      await apiPut(`/api/b/${bookId}/recurring/${rule.id}`, {
        isActive: !rule.isActive,
      });
    } catch (e) {
      // This site had no failure branch before this migration — a failed
      // toggle was silently swallowed. The unconditional refetch below
      // already re-syncs the control to server truth (so it snaps back to
      // its real state); this toast is what tells the user why it reverted.
      toast.error(toMessage(e, "Failed to update the rule"));
    }
    void fetchData(false);
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const today = toDateString(new Date());
  const dueRules = rules.filter(
    (r) =>
      r.isActive &&
      isRecurringRuleDue(
        r.nextDate,
        today,
        r.autoCreateDaysBefore ?? 0,
        r.businessDaysOnly
      )
  );
  const todayDate = parseDateString(today);
  const calendarStartDate = new Date(todayDate);
  calendarStartDate.setDate(todayDate.getDate() - todayDate.getDay());

  const calendarDays: CalendarDay[] = Array.from(
    { length: CALENDAR_WEEKS * DAYS_PER_WEEK },
    (_, index) => {
      const date = new Date(calendarStartDate);
      date.setDate(calendarStartDate.getDate() + index);
      const dateString = toDateString(date);

      return {
        date: dateString,
        dayNumber: date.getDate(),
        monthLabel: date.toLocaleDateString("en-US", { month: "short" }),
        isToday: dateString === today,
        isPast: dateString < today,
      };
    }
  );

  const calendarRangeStart = calendarDays[0]?.date ?? today;
  const calendarRangeEnd = calendarDays[calendarDays.length - 1]?.date ?? today;
  const occurrencesByDate = new Map<string, CalendarOccurrence[]>();

  for (const rule of rules) {
    const occurrences = getRuleOccurrencesInRange(
      rule,
      calendarRangeStart,
      calendarRangeEnd,
      today
    );

    for (const date of occurrences) {
      const existingOccurrences = occurrencesByDate.get(date) ?? [];
      existingOccurrences.push({ ruleId: rule.id, ruleName: rule.name, type: "scheduled" });
      occurrencesByDate.set(date, existingOccurrences);
    }
  }

  for (const txn of completedTxns) {
    const existingOccurrences = occurrencesByDate.get(txn.date) ?? [];
    existingOccurrences.push({
      ruleId: txn.recurringRuleId,
      ruleName: txn.ruleName,
      type: "completed",
    });
    occurrencesByDate.set(txn.date, existingOccurrences);
  }

  for (const dailyOccurrences of occurrencesByDate.values()) {
    dailyOccurrences.sort((a, b) => a.ruleName.localeCompare(b.ruleName));
  }

  const calendarWeeks = Array.from({ length: CALENDAR_WEEKS }, (_, index) =>
    calendarDays.slice(index * DAYS_PER_WEEK, (index + 1) * DAYS_PER_WEEK)
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">
          Recurring Transactions
        </h1>
        <div className="flex items-center gap-3">
          {dueRules.length > 0 && (
            <Button variant="secondary" onClick={handleProcessAll}>
              Process All Due ({dueRules.length})
            </Button>
          )}
          <Button onClick={() => setShowModal(true)}>New Rule</Button>
        </div>
      </div>

      <section className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-fg">
            Upcoming Calendar (Next 4 Weeks)
          </h2>
        </div>

        <div className="grid grid-cols-7 border-b border-border-secondary">
          {CALENDAR_DAY_LABELS.map((label) => (
            <div
              key={label}
              className="px-2 py-2 text-center text-xs font-medium text-fg-tertiary"
            >
              {label}
            </div>
          ))}
        </div>

        <div data-testid="recurring-calendar">
          {calendarWeeks.map((week, weekIndex) => (
            <div
              key={weekIndex}
              data-testid="calendar-week-row"
              className={cn(
                "grid grid-cols-7",
                weekIndex < calendarWeeks.length - 1 && "border-b border-border-secondary"
              )}
            >
              {week.map((day) => {
                const occurrences = occurrencesByDate.get(day.date) ?? [];

                return (
                  <div
                    key={day.date}
                    data-testid={`calendar-day-cell-${day.date}`}
                    className={cn(
                      "min-h-24 px-2 py-2 border-r border-border-secondary",
                      day.isPast && "bg-surface-secondary",
                      !day.isPast && "bg-surface",
                      day.isToday && "bg-accent-subtle",
                      day.date === week[week.length - 1]?.date && "border-r-0"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "text-xs",
                          day.isToday ? "font-semibold text-fg-accent" : "text-fg-secondary"
                        )}
                      >
                        {day.dayNumber}
                      </span>
                      {day.dayNumber === 1 && (
                        <span className="text-[10px] uppercase tracking-wide text-fg-tertiary">
                          {day.monthLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 space-y-1">
                      {occurrences.map((occurrence, i) => (
                        <span
                          key={`${day.date}-${occurrence.ruleId}-${occurrence.type}-${i}`}
                          title={occurrence.ruleName}
                          className={cn(
                            "block max-w-full truncate rounded-full px-2 py-0.5 text-[11px] leading-4",
                            occurrence.type === "completed"
                              ? "bg-surface-tertiary text-fg-secondary"
                              : "bg-accent-subtle text-fg-accent"
                          )}
                        >
                          {occurrence.ruleName}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-4">
        {rules.map((rule) => {
          const isDue =
            rule.isActive &&
            isRecurringRuleDue(
              rule.nextDate,
              today,
              rule.autoCreateDaysBefore ?? 0,
              rule.businessDaysOnly
            );
          const amount = rule.templateSplits.reduce(
            (max, s) => Math.max(max, Math.abs(s.amount)),
            0
          );

          const ruleDesc = describeRecurrence({
            frequency: rule.frequency,
            interval: rule.interval ?? 1,
            daysOfWeek: rule.daysOfWeek ? JSON.parse(rule.daysOfWeek) : null,
            weekOfMonth: rule.weekOfMonth,
            daysOfMonth: rule.daysOfMonth ? JSON.parse(rule.daysOfMonth) : null,
          });

          const isHighlighted = rule.id === highlightRuleId;
          const isDeleting = deletingRuleIds.includes(rule.id);
          const isExiting = exitingRuleIds.includes(rule.id);

          return (
            <div
              key={rule.id}
              data-testid={`recurring-rule-card-${rule.id}`}
              ref={isHighlighted ? highlightedRef : undefined}
              className={cn(
                "bg-surface rounded-lg border shadow-soft overflow-hidden transition-all duration-300",
                "transition-[opacity,transform,filter] ease-out",
                isDue ? "border-border-warning" : "border-border",
                !rule.isActive && "opacity-60",
                isHighlighted && "ring-2 ring-purple-400 border-purple-400 bg-purple-50/30",
                isExiting && "opacity-0 translate-x-4 scale-[0.98] blur-[1px] pointer-events-none"
              )}
            >
              <div className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-fg">
                        {rule.name}
                      </h3>
                      {isDue && (
                        <span className="text-xs px-2 py-0.5 bg-warning-subtle text-fg-warning rounded-full">
                          Due
                        </span>
                      )}
                      {!rule.isActive && (
                        <span className="text-xs px-2 py-0.5 bg-surface-tertiary text-fg-tertiary rounded-full">
                          Inactive
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-fg-tertiary mt-1">
                      {rule.payee && (
                        <span className="text-fg-secondary">{rule.payee.name} &middot; </span>
                      )}
                      {ruleDesc}
                      {rule.businessDaysOnly && " (business days only)"} | Next:{" "}
                      {formatDate(
                        getOccurrenceDate(rule.nextDate, rule.businessDaysOnly)
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-lg font-semibold text-fg tabular-nums">
                    {formatCurrency(amount)}
                  </span>
                  <div className="flex items-center gap-2">
                    {isDue && (
                      <Button
                        size="sm"
                        onClick={() => handleProcessRule(rule.id)}
                      >
                        Process Now
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingRule(rule)}
                      disabled={isDeleting}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(rule)}
                      disabled={isDeleting}
                    >
                      {rule.isActive ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(rule.id)}
                      disabled={isDeleting}
                      className="text-fg-danger hover:text-fg-danger"
                    >
                      {isDeleting ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="px-6 py-3 bg-surface-secondary border-t border-border-secondary">
                <p className="text-sm text-fg-secondary">
                  {rule.templateDescription || "No description"} |{" "}
                  {rule.templateSplits.map((s) =>
                    s.account.parentId ? getAccountShortName(s.account.name) : s.account.name
                  ).join(" / ")}
                </p>
              </div>
            </div>
          );
        })}

        {rules.length === 0 && (
          <div className="text-center py-12 text-fg-tertiary">
            No recurring rules yet.{" "}
            <button
              onClick={() => setShowModal(true)}
              className="text-fg-accent hover:underline"
            >
              Create your first recurring transaction
            </button>
          </div>
        )}
      </div>

      <Modal
        isOpen={showModal}
        onClose={closeNewRuleModal}
        title="New Recurring Transaction"
        size="lg"
      >
        <RecurringForm
          prefill={prefillData}
          accounts={accounts}
          bookId={bookId}
          onSubmit={async (data) => {
            try {
              await apiPost(`/api/b/${bookId}/recurring`, data);
              closeNewRuleModal();
              void fetchData(false);
            } catch (e) {
              toast.error(toMessage(e, "Failed to create recurring rule"));
            }
          }}
          onCancel={closeNewRuleModal}
        />
      </Modal>

      <Modal
        isOpen={!!editingRule}
        onClose={() => setEditingRule(null)}
        title="Edit Recurring Transaction"
        size="lg"
      >
        {editingRule && (
          <RecurringForm
            rule={editingRule}
            accounts={accounts}
            bookId={bookId}
            onSubmit={async (data) => {
              try {
                await apiPut(`/api/b/${bookId}/recurring/${editingRule.id}`, data);
                setEditingRule(null);
                void fetchData(false);
              } catch (e) {
                toast.error(toMessage(e, "Failed to update recurring rule"));
              }
            }}
            onCancel={() => setEditingRule(null)}
          />
        )}
      </Modal>
    </div>
  );
}

type Frequency = "daily" | "weekly" | "monthly" | "yearly";

type RecurringFormData = {
  name: string;
  frequency: Frequency;
  interval: number;
  daysOfWeek: number[] | null;
  weekOfMonth: string | null;
  daysOfMonth: number[] | null;
  startDate: string;
  endDate: string | null;
  autoCreateDaysBefore: number;
  businessDaysOnly: boolean;
  templateDescription: string;
  templateSplits: SplitInput[];
  payeeId: number | null;
  payeeName?: string;
};

const FREQUENCY_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const WEEKLY_SCOPE_OPTIONS = [
  { value: "every", label: "Every week" },
  { value: "2", label: "Every 2nd week" },
  { value: "3", label: "Every 3rd week" },
  { value: "4", label: "Every 4th week" },
  { value: "5", label: "Every 5th week" },
  { value: "last", label: "Last week of the month" },
];

const MONTHLY_INTERVAL_OPTIONS = [
  { value: "1", label: "Every month" },
  { value: "2", label: "Every other month" },
  { value: "3", label: "Every 3rd month" },
  { value: "4", label: "Every 4th month" },
  { value: "5", label: "Every 5th month" },
  { value: "6", label: "Every 6th month" },
];

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

type PrefillData = {
  name: string;
  templateDescription: string;
  templateSplits: SplitInput[];
  payeeId?: number | null;
  payeeName?: string;
};

function RecurringForm({
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
      interval: frequency === "daily" ? intervalVal : frequency === "monthly" ? intervalVal : 1,
      daysOfWeek: frequency === "weekly" && daysOfWeek.length > 0 ? daysOfWeek : null,
      weekOfMonth: frequency === "weekly" ? weekOfMonth : null,
      daysOfMonth: frequency === "monthly" && daysOfMonth.length > 0 ? daysOfMonth : null,
      startDate,
      endDate: endDate || null,
      autoCreateDaysBefore,
      businessDaysOnly,
      templateDescription: description,
      templateSplits: splits,
      payeeId: normalizedPayeeName ? payeeId : null,
      payeeName: normalizedPayeeName || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Frequency"
          id="frequency"
          value={frequency}
          onChange={(e) => {
            const f = e.target.value as Frequency;
            setFrequency(f);
            setIntervalVal(1);
            setDaysOfWeek([]);
            setWeekOfMonth("every");
            setDaysOfMonth([]);
          }}
          options={FREQUENCY_OPTIONS}
        />
        <Input
          type="date"
          label="Start Date"
          id="startDate"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          required
        />
      </div>

      {/* Daily: interval input */}
      {frequency === "daily" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg-secondary">Repeat every</span>
          <input
            type="number"
            min={1}
            max={MAX_DAILY_INTERVAL_DAYS}
            value={intervalVal}
            onFocus={(e) => selectInputContents(e.currentTarget)}
            onChange={(e) =>
              setIntervalVal(
                Math.min(
                  MAX_DAILY_INTERVAL_DAYS,
                  Math.max(1, parseInt(e.target.value) || 1)
                )
              )
            }
            className="w-16 rounded-lg border border-border px-2 py-1.5 text-sm text-center focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
          />
          <span className="text-sm text-fg-secondary">day(s)</span>
        </div>
      )}

      {/* Weekly: scope dropdown + day-of-week toggles */}
      {frequency === "weekly" && (
        <div className="space-y-3">
          <Select
            label="Week Pattern"
            id="weekOfMonth"
            value={weekOfMonth}
            onChange={(e) => setWeekOfMonth(e.target.value)}
            options={WEEKLY_SCOPE_OPTIONS}
          />
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1.5">
              Days of Week
            </label>
            <div className="flex gap-1.5">
              {DAY_LABELS.map((label, i) => (
                <button
                  key={i}
                  type="button"
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
          </div>
        </div>
      )}

      {/* Monthly: interval dropdown + day-of-month grid */}
      {frequency === "monthly" && (
        <div className="space-y-3">
          <Select
            label="Month Pattern"
            id="monthInterval"
            value={String(intervalVal)}
            onChange={(e) => setIntervalVal(parseInt(e.target.value))}
            options={MONTHLY_INTERVAL_OPTIONS}
          />
          <div>
            <label className="block text-sm font-medium text-fg-secondary mb-1.5">
              Days of Month
            </label>
            <div className="grid grid-cols-7 gap-1.5">
              {/* Stops at 30: day 31 clamps to the last day of every month, so a
                  "31" button would be an exact duplicate of "Last" below. */}
              {Array.from({ length: 30 }, (_, i) => i + 1).map((day) => (
                <button
                  key={day}
                  type="button"
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
          </div>
        </div>
      )}

      <Input
        type="date"
        label="End Date (optional)"
        id="endDate"
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
      />

      <Input
        type="number"
        min={0}
        max={MAX_AUTO_CREATE_DAYS_BEFORE}
        label="Auto-create days before scheduled date"
        id="autoCreateDaysBefore"
        value={autoCreateDaysBefore}
        onChange={(e) => {
          const parsed = parseInt(e.target.value, 10);
          const nextValue = Number.isNaN(parsed) ? 0 : parsed;
          setAutoCreateDaysBefore(
            Math.min(MAX_AUTO_CREATE_DAYS_BEFORE, Math.max(0, nextValue))
          );
        }}
      />

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-fg">
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
          An occurrence that falls on a weekend is created on the next business
          day instead. The schedule itself does not move.
        </p>
      </div>

      <Input
        label="Description"
        id="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="e.g., Rent payment to landlord"
      />

      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          Transaction Splits
        </label>
        <SplitEditor
          splits={splits}
          onChange={setSplits}
          accounts={accounts.filter((a) => a.isActive)}
        />
      </div>

      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{rule ? "Save Changes" : "Create Rule"}</Button>
      </div>
    </form>
  );
}

export default function RecurringPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
        </div>
      }
    >
      <RecurringPageInner />
    </Suspense>
  );
}
