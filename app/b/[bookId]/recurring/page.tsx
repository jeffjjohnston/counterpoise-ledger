"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import { Link, useRouter, useSearchParams } from "@/lib/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import {
  RecurringForm,
  type PrefillData,
} from "@/components/recurring/RecurringForm";
import { formatCurrency, formatDate, toDateString, getAccountShortName } from "@/lib/wasm-client";
import {
  describeRecurrence,
  flattenAccounts,
  getNextDate,
} from "@/lib/wasm-client";
import {
  buildRuleRecurrenceConfig,
  getOccurrenceDate,
  isRecurringRuleDue,
} from "@/lib/wasm-client";
import { cn } from "@/lib/utils";
import { useBookId } from "@/hooks/useBookId";
import { useBookRole } from "@/components/BookRoleProvider";
import { apiGet, apiPost, apiPut, toMessage } from "@/lib/api-client";
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
  const { canWrite } = useBookRole();
  const toast = useToast();
  const [rules, setRules] = useState<RecurringRuleWithSplits[]>([]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [completedTxns, setCompletedTxns] = useState<RecurringTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [prefillData, setPrefillData] = useState<PrefillData | undefined>(undefined);
  const searchParams = useSearchParams();
  const router = useRouter();

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
    // A viewer cannot create a rule, so the link opens the list only. The
    // effect runs again when the role loads.
    if (!canWrite) return;
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
  }, [bookId, canWrite, searchParams]);

  const closeNewRuleModal = useCallback(() => {
    setShowModal(false);
    setPrefillData(undefined);
    if (searchParams.get("fromTransaction")) {
      router.replace(`/b/${bookId}/recurring`);
    }
  }, [router, searchParams, bookId]);

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

  // The search narrows the list below it and nothing else. The calendar keeps
  // every upcoming occurrence, and `dueRules` keeps every due rule, so the
  // count on "Process All Due" still says what that button will act on.
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredRules = rules.filter(
    (rule) =>
      rule.name.toLowerCase().includes(normalizedSearchTerm) ||
      (rule.payee?.name.toLowerCase().includes(normalizedSearchTerm) ?? false)
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">
          Recurring Transactions
        </h1>
        <div className="flex items-center gap-3">
          {canWrite && dueRules.length > 0 && (
            <Button variant="secondary" onClick={handleProcessAll}>
              Process All Due ({dueRules.length})
            </Button>
          )}
          {canWrite && <Button onClick={() => setShowModal(true)}>New Rule</Button>}
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

      <div className="mb-4">
        <Input
          id="recurring-search"
          label="Search recurring rules"
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Filter by name or payee..."
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-4">
        {filteredRules.map((rule) => {
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

          return (
            <div
              key={rule.id}
              data-testid={`recurring-rule-card-${rule.id}`}
              className={cn(
                "bg-surface rounded-lg border shadow-soft overflow-hidden",
                isDue ? "border-border-warning" : "border-border",
                !rule.isActive && "opacity-60"
              )}
            >
              <div className="flex items-stretch justify-between">
                {/* One link per row, and it does not wrap the Pause control:
                    an interactive element inside an anchor is invalid, and a
                    click on it would follow the link as well as fire. */}
                <Link
                  href={`/b/${bookId}/recurring/${rule.id}`}
                  className="min-w-0 flex-1 px-6 py-4 transition-colors hover:bg-surface-tertiary"
                >
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
                </Link>
                <div className="flex items-center gap-4 px-6 py-4">
                  <span className="text-lg font-semibold text-fg tabular-nums">
                    {formatCurrency(amount)}
                  </span>
                  {/* Pause/Resume is the one row action that stays, and it
                      shows only for a user who can write. Edit, Delete and
                      Process Now stay on the detail page, where the rule's
                      history helps the user decide. */}
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(rule)}
                    >
                      {rule.isActive ? "Pause" : "Resume"}
                    </Button>
                  )}
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
            No recurring rules yet.
            {canWrite && (
              <>
                {" "}
                <button
                  onClick={() => setShowModal(true)}
                  className="text-fg-accent hover:underline"
                >
                  Create your first recurring transaction
                </button>
              </>
            )}
          </div>
        )}

        {rules.length > 0 && filteredRules.length === 0 && (
          <div className="text-center py-12 text-fg-tertiary">
            No recurring rules match your search.
          </div>
        )}
      </div>

      {/* The role can drop to viewer while the form is open. A viewer must
          not keep an editable form. */}
      <Modal
        isOpen={showModal && canWrite}
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
    </div>
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
