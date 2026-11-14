"use client";

import { useState, useEffect, useCallback, useId, useMemo, useRef, useImperativeHandle, forwardRef } from "react";
import { useBookId } from "@/hooks/useBookId";
import { useSubmitGuard } from "@/hooks/useSubmitGuard";
import { apiGet, apiPost } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DateInput } from "@/components/ui/DateInput";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { Textarea } from "@/components/ui/Textarea";
import { SplitEditor } from "./SplitEditor";
import { tabTo } from "@/components/transactions/tab-to";
import {
  toDateString,
  resolveAmountOnBlur,
  getAccountShortName,
  parseStrictCurrency,
} from "@/lib/wasm-client";
import { validateSplits } from "@/lib/wasm-client";
import { prepareSaveChord } from "@/lib/save-chord";
import type {
  AccountWithBalance,
  PlaidLinkData,
  SplitInput,
  TransactionWithSplits,
} from "@/types";
import { PlaidBanner } from "./PlaidBanner";
import { useInvestmentEntry } from "./useInvestmentEntry";
import { InvestmentEntrySection } from "./InvestmentEntrySection";
import { NewExpenseSubflow } from "./NewExpenseSubflow";
import { TransactionAuthorship } from "./TransactionAuthorship";
import { EntryPatternChip } from "./EntryPatternChip";
import { useEntrySuggestion } from "@/hooks/useEntrySuggestion";
import { fillFromPattern, outcomeOf, rangeHint, type PatternFill } from "@/lib/entry-patterns";
import type { EntryPattern } from "@/lib/typesafe/types";
import {
  buildSimpleEntry,
  buildSubmitPayload,
  editFieldsFromTransaction,
  reconciledEditChanges,
  reconciledEditPrompt,
  type EntryResult,
  type TransactionFormSubmitData,
  type TransactionMode,
} from "./transaction-form-fields";

interface TransactionFormProps {
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  editingTransaction?: TransactionWithSplits | null;
  plaidData?: PlaidLinkData | null;
  onPlaidUnlinked?: () => void;
  /**
   * `true` or the saved transaction's id when the save succeeded; the entry
   * outcome is recorded only then, with the id when there is one.
   */
  onSubmit: (data: TransactionFormSubmitData) => void | boolean | number | Promise<void | boolean | number>;
  onCancel?: () => void;
  onDelete?: () => void;
  onMakeRecurring?: (transactionId: number) => void;
  onAccountsUpdate?: () => void;
  isInvestmentAccountSelected?: boolean;
  fullLayout?: boolean;
  /** Show the transaction without edit controls. For a viewer. */
  readOnly?: boolean;
}

/** The wait after the last keystroke in the payee field before the payee search. */
export const PAYEE_SEARCH_DELAY_MS = 150;

export interface TransactionFormHandle {
  focus: () => void;
}

export const TransactionForm = forwardRef<TransactionFormHandle, TransactionFormProps>(function TransactionForm({
  accounts,
  selectedAccountId,
  editingTransaction,
  plaidData,
  onPlaidUnlinked,
  onSubmit,
  onCancel,
  onDelete,
  onMakeRecurring,
  onAccountsUpdate,
  isInvestmentAccountSelected = false,
  fullLayout = false,
  readOnly = false,
}, ref) {
  const bookId = useBookId();
  const toast = useToast();
  const [date, setDate] = useState(toDateString(new Date()));
  const [description, setDescription] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [payeeSuggestions, setPayeeSuggestions] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [mode, setMode] = useState<TransactionMode>("simple");
  const [simpleAmount, setSimpleAmount] = useState("");
  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [toAccountId, setToAccountId] = useState<number | null>(null);
  const [splits, setSplits] = useState<SplitInput[]>([]);
  const [hasPendingExpression, setHasPendingExpression] = useState(false);
  const [showNewExpense, setShowNewExpense] = useState(false);
  // Lifted from NewExpenseSubflow so the draft and the in-flight guard
  // survive a mode switch: both render sites below sit inside mode
  // conditionals, so the subflow component itself unmounts on a switch even
  // though `showNewExpense` (owned here) does not. See NewExpenseSubflow.tsx.
  const [newExpenseName, setNewExpenseName] = useState("");
  const [newExpenseParentId, setNewExpenseParentId] = useState<number | null>(null);
  const [isCreatingExpense, setIsCreatingExpense] = useState(false);
  const investment = useInvestmentEntry({
    accounts,
    selectedAccountId,
    editingTransaction,
  });
  // useState setters are referentially stable, so naming them directly keeps the
  // deps honest without re-running on every render the way `investment` would.
  const { setInvestmentAccountId, setPendingNewAccountId } = investment;
  const [isReconciled, setIsReconciled] = useState(false);
  const [isFloating, setIsFloating] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem("txnFormDetailsExpanded") === "true";
      } catch {
        return false;
      }
    }
    return false;
  });

  // Persist details toggle to localStorage (skip when auto-expanded for editing)
  useEffect(() => {
    if (editingTransaction) return;
    try {
      localStorage.setItem("txnFormDetailsExpanded", String(secondaryExpanded));
    } catch {
      // Ignore localStorage errors
    }
  }, [secondaryExpanded, editingTransaction]);

  const formRef = useRef<HTMLFormElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const payeeRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const journalAddButtonRef = useRef<HTMLButtonElement>(null);
  const autoFilledPayeeId = useRef<number | null>(null);
  // The entry fill (guides/typesafe-experiment.md, "Entry suggestions"). The
  // fill changes only the fields that the user has not set since the reset;
  // a TypeSafe answer changes nothing after any edit since the last fill.
  const accountsTouched = useRef(false);
  const amountTouched = useRef(false);
  const editedSinceFill = useRef(false);
  // The amount in cents that the user typed in simple mode. It stays when a
  // journal fill switches the mode, so a later fill keeps it too.
  const typedCents = useRef<number | null>(null);
  const chipShown = useRef(false);
  // The fill that the form shows. It, not the hook's pick, names the chip's
  // pattern and the source of the outcome: a dropped TypeSafe answer changes
  // nothing in the form.
  const [appliedFill, setAppliedFill] = useState<{
    pattern: EntryPattern;
    fill: PatternFill;
    amountFilled: boolean;
    picked: boolean;
    index: number;
    /** The automatic fill that the user saw first: history or TypeSafe. */
    source: "history" | "typesafe";
  } | null>(null);

  // One save at a time. The entry stays in the form until the save handler
  // reports the result.
  const submitGuard = useSubmitGuard();
  const saving = submitGuard.saving;
  // The fill of the entry whose last save failed. Its outcome is not
  // `abandoned`: the user tried to save it.
  const failedFill = useRef<typeof appliedFill>(null);

  const compact = !fullLayout && !editingTransaction;

  useImperativeHandle(ref, () => ({
    focus: () => {
      payeeRef.current?.focus();
    },
  }));

  // Ctrl/Cmd+Enter to submit from anywhere in the form. handleSubmit drops
  // the submit while a save is in flight.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.addEventListener("keydown", handler);
    return () => form.removeEventListener("keydown", handler);
  }, []);

  // Amount is the last field of the register's quick-entry row and Add is the
  // next element in it, so Tab is how the row gets committed from the
  // keyboard. tabTo() explains why the form moves the focus itself. The
  // desktop layout does not use this: its amount field is not the last one
  // before its submit button.
  const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) =>
    tabTo(e, addButtonRef);

  const simpleAccountIds = useMemo(() => {
    return new Set(
      accounts
        .filter(
          (account) =>
            account.isActive &&
            !(account.subtype === "investment" && !account.isInvestmentCash)
        )
        .map((account) => account.id)
    );
  }, [accounts]);

  const resolveSimpleAccountId = useCallback(
    (accountId: number | null) => {
      if (!accountId) return null;
      if (simpleAccountIds.has(accountId)) return accountId;
      const investmentCashAccount = accounts.find(
        (account) =>
          account.parentId === accountId &&
          account.isInvestmentCash &&
          account.isActive
      );
      return investmentCashAccount?.id ?? null;
    },
    [accounts, simpleAccountIds]
  );

  // The selected account as it appears in the simple dropdowns (investment
  // accounts surface as their investment-cash sub-account).
  const resolvedSelectedAccountId = useMemo(
    () => resolveSimpleAccountId(selectedAccountId),
    [resolveSimpleAccountId, selectedAccountId]
  );

  // Keep the currently-selected account present in either the From or To
  // dropdown: when the user picks an account that displaces it on one side,
  // move it to the other side. Skipped while editing so existing transactions
  // can have their accounts changed freely.
  const markAccountsTouched = () => {
    accountsTouched.current = true;
    editedSinceFill.current = true;
  };
  const markAmountTouched = () => {
    amountTouched.current = true;
    editedSinceFill.current = true;
  };
  const handleSplitsChange = (next: SplitInput[]) => {
    markAccountsTouched();
    markAmountTouched();
    // The split amounts are now the user's; a typed simple amount no longer applies.
    typedCents.current = null;
    setSplits(next);
  };
  // The blur resolves an expression ("50+5" becomes "55.00"); the kept cents
  // follow it.
  const handleAmountBlur = () => {
    const resolved = resolveAmountOnBlur(simpleAmount);
    setSimpleAmount(resolved);
    if (amountTouched.current) typedCents.current = parseStrictCurrency(resolved);
  };
  const handleAmountChange = (value: string) => {
    markAmountTouched();
    typedCents.current = parseStrictCurrency(value);
    setSimpleAmount(value);
  };

  const handleFromAccountChange = (id: number | null) => {
    markAccountsTouched();
    setFromAccountId(id);
    if (editingTransaction) return;
    if (
      resolvedSelectedAccountId !== null &&
      id !== resolvedSelectedAccountId &&
      toAccountId !== resolvedSelectedAccountId
    ) {
      setToAccountId(resolvedSelectedAccountId);
    }
  };

  const handleToAccountChange = (id: number | null) => {
    markAccountsTouched();
    setToAccountId(id);
    if (editingTransaction) return;
    if (
      resolvedSelectedAccountId !== null &&
      id !== resolvedSelectedAccountId &&
      fromAccountId !== resolvedSelectedAccountId
    ) {
      setFromAccountId(resolvedSelectedAccountId);
    }
  };

  // Surface-only warning: true when a NEW simple-mode entry would involve
  // neither the From nor the To = the account being viewed. The From/To
  // handlers keep that invariant, so this can only flip true when a direct
  // setter (payee last-account auto-fill, new-expense creation) overwrites the
  // side that held the viewed account. Derived from live state, so it also
  // clears itself once a dropdown points back at the viewed account.
  const selectedAccountMissing = useMemo(
    () =>
      mode === "simple" &&
      !editingTransaction &&
      resolvedSelectedAccountId !== null &&
      fromAccountId !== null &&
      toAccountId !== null &&
      fromAccountId !== resolvedSelectedAccountId &&
      toAccountId !== resolvedSelectedAccountId,
    [mode, editingTransaction, resolvedSelectedAccountId, fromAccountId, toAccountId]
  );

  const renderSelectedAccountWarning = () => {
    if (!selectedAccountMissing) return null;
    const viewed = accounts.find((account) => account.id === selectedAccountId);
    const name = viewed ? getAccountShortName(viewed.name) : "this account";
    return (
      <div
        role="status"
        className="mt-2 flex items-center gap-1.5 rounded-md bg-warning-subtle px-2 py-1 text-xs text-fg-warning"
      >
        <svg
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        </svg>
        <span>{`Won't appear in "${name}" — the account you're viewing.`}</span>
      </div>
    );
  };

  const resetForm = useCallback(() => {
    // Keep the date field value so users can enter multiple transactions on the same day
    setDescription("");
    setCheckNumber("");
    setNotes("");
    setPayeeName("");
    setPayeeSuggestions([]);
    setSimpleAmount("");
    setFromAccountId(resolveSimpleAccountId(selectedAccountId));
    setToAccountId(null);
    autoFilledPayeeId.current = null;
    accountsTouched.current = false;
    amountTouched.current = false;
    editedSinceFill.current = false;
    chipShown.current = false;
    typedCents.current = null;
    failedFill.current = null;
    setAppliedFill(null);
    const defaultAccount = accounts.find((a) => a.type === "expense") || accounts[0];
    setSplits([
      { accountId: defaultAccount?.id || 0, amount: 0 },
      { accountId: accounts[0]?.id || 0, amount: 0 },
    ]);
    setMode(isInvestmentAccountSelected ? "investment" : "simple");
    setIsReconciled(false);
    setIsFloating(false);
    investment.reset();
  }, [accounts, resolveSimpleAccountId, selectedAccountId, isInvestmentAccountSelected, investment]);

  // A save that ends after a later render must reset with the current
  // accounts, not with those of the render that started it.
  const resetFormRef = useRef(resetForm);
  useEffect(() => {
    resetFormRef.current = resetForm;
  });

  const isEditing = Boolean(editingTransaction);

  const handleModeChange = (nextMode: TransactionMode) => {
    if (isEditing) return;
    // A mode change is the user's choice: a later fill must not undo it.
    markAccountsTouched();
    markAmountTouched();
    setMode(nextMode);
    if (nextMode === "journal") {
      setSplits([
        { accountId: selectedAccountId || 0, amount: 0 },
        { accountId: 0, amount: 0 },
      ]);
    }
  };

  // Fill the form from a saved transaction. resetForm() is the other way
  // to initialize the form, for a new entry.
  const loadTransaction = (transaction: TransactionWithSplits) => {
    const fields = editFieldsFromTransaction(transaction);
    setDate(fields.date);
    setDescription(fields.description);
    setCheckNumber(fields.checkNumber);
    setNotes(fields.notes);
    setPayeeName(fields.payeeName);
    setIsReconciled(fields.isReconciled);
    setIsFloating(fields.isFloating);
    setSecondaryExpanded(true);
    setSplits(fields.splits);
    setMode(fields.mode);
    if (fields.simple) {
      setSimpleAmount(fields.simple.amount);
      setToAccountId(fields.simple.toAccountId);
      setFromAccountId(fields.simple.fromAccountId);
    }
    if (fields.investment) {
      investment.restore(fields.investment);
    }
  };

  useEffect(() => {
    if (editingTransaction) {
      loadTransaction(editingTransaction);
    } else {
      resetForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTransaction]);

  useEffect(() => {
    const query = payeeName.trim();
    if (!query) {
      setPayeeSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const fetchSuggestions = async () => {
      try {
        const data = await apiGet<Array<{ id: number; name: string }>>(
          `/api/b/${bookId}/payees?search=${encodeURIComponent(query)}&limit=8`,
          { signal: controller.signal }
        );
        setPayeeSuggestions(Array.isArray(data) ? data : []);
      } catch (error) {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        console.error("Failed to fetch payee suggestions", error);
      }
    };
    // setTimeout expects a void-returning callback; fetchSuggestions
    // already catches its own errors, so this cannot reject.
    const timeout = setTimeout(() => {
      void fetchSuggestions();
    }, PAYEE_SEARCH_DELAY_MS);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [bookId, payeeName]);

  // The payee that the field names, by the server's rule
  // (find_payee_by_name): the exact spelling, else the oldest payee whose name
  // differs only by letter case. The save resolves the same payee.
  const matchedPayee = useMemo(() => {
    const trimmed = payeeName.trim();
    if (!trimmed) return null;
    const exact = payeeSuggestions.find((s) => s.name === trimmed);
    if (exact) return exact;
    const variants = payeeSuggestions.filter((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    return variants.reduce<(typeof variants)[number] | null>(
      (oldest, s) => (oldest === null || s.id < oldest.id ? s : oldest),
      null
    );
  }, [payeeName, payeeSuggestions]);
  const matchedPayeeId = matchedPayee?.id ?? null;

  const entryActive =
    !editingTransaction &&
    !readOnly &&
    (mode === "simple" || mode === "journal") &&
    resolvedSelectedAccountId !== null;
  // The amount that the user typed before the payee, with its direction on
  // the register's account: negative when money leaves it.
  const typedAmount = useCallback(() => {
    const cents = typedCents.current;
    if (!amountTouched.current || cents === null) return null;
    return mode === "simple" && toAccountId !== null && toAccountId === resolvedSelectedAccountId
      ? cents
      : -cents;
  }, [mode, toAccountId, resolvedSelectedAccountId]);
  const entryFill = useEntrySuggestion({
    bookId,
    accountId: resolvedSelectedAccountId,
    payeeId: matchedPayeeId,
    date,
    typedAmount,
    active: entryActive,
  });

  // A fill belongs to one payee. When the payee changes, the fields that the
  // fill set and the user did not touch go back to the empty entry.
  const appliedFillRef = useRef(appliedFill);
  useEffect(() => {
    appliedFillRef.current = appliedFill;
  });
  useEffect(() => {
    const previous = appliedFillRef.current;
    if (previous) {
      if (!accountsTouched.current) {
        if (previous.fill.mode === "journal") setMode("simple");
        setFromAccountId(resolvedSelectedAccountId);
        setToAccountId(null);
      }
      if (!amountTouched.current) setSimpleAmount("");
    }
    setAppliedFill(null);
    chipShown.current = false;
    // Only a change of the payee clears the fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedPayeeId]);

  /**
   * Fills the form from a pattern. `force` (a pick from the chip) sets every
   * field; otherwise only the fields that the user has not set.
   */
  const applyFill = (
    pattern: EntryPattern,
    options: { force: boolean; picked: boolean; index: number; source: "history" | "typesafe" }
  ) => {
    if (resolvedSelectedAccountId === null) return;
    const fill = fillFromPattern(pattern, resolvedSelectedAccountId);
    const setAccounts = options.force || !accountsTouched.current;
    // A pick keeps an amount that the user typed when the pattern has none.
    const setAmount = options.force
      ? pattern.stable || !amountTouched.current
      : !amountTouched.current;
    if (fill.mode === "simple" && mode === "simple") {
      if (setAccounts) {
        setFromAccountId(fill.fromAccountId);
        setToAccountId(fill.toAccountId);
      }
      if (setAmount) setSimpleAmount(fill.amount);
    } else {
      // A journal fill sets the accounts. The amounts are the pattern's when
      // they repeat; else this account's line gets the typed amount, or the
      // total when it repeats, and the other lines stay empty.
      if (!setAccounts) return;
      const accountId = resolvedSelectedAccountId;
      const net = pattern.splits
        .filter((split) => split.accountId === accountId)
        .reduce((sum, split) => sum + split.amount, 0);
      // The amount that the user set: typed in simple mode, or the net of this
      // account's lines edited in journal mode.
      const edited =
        mode === "journal"
          ? Math.abs(splits.filter((split) => split.accountId === accountId).reduce((sum, split) => sum + split.amount, 0))
          : 0;
      const typed = !setAmount ? (typedCents.current ?? (edited > 0 ? edited : null)) : null;
      const total =
        setAmount && !pattern.stable && pattern.range.min === pattern.range.max ? pattern.range.max : null;
      const own = typed ?? total;
      // The amount goes on the first line of this account only, as one net
      // amount; other lines of the account stay empty.
      const firstOwn = pattern.splits.findIndex((split) => split.accountId === accountId);
      setMode("journal");
      setSplits(
        pattern.splits.map((split, index) => {
          if (setAmount && pattern.stable) return { accountId: split.accountId, amount: split.amount };
          const mine = own !== null && index === firstOwn;
          return { accountId: split.accountId, amount: mine ? (net <= 0 ? -own : own) : 0 };
        })
      );
    }
    editedSinceFill.current = false;
    setAppliedFill({
      pattern,
      fill,
      amountFilled: pattern.stable && setAmount,
      picked: options.picked,
      index: options.index,
      source: options.source,
    });
  };

  // The newest pattern at once; the TypeSafe pick when it arrives, only while
  // the user has not edited the form since the last fill.
  useEffect(() => {
    if (!entryFill.patterns || !entryFill.pick) return;
    const index = entryFill.patterns.findIndex((pattern) => pattern.key === entryFill.pick?.key);
    if (index < 0) return;
    if (entryFill.pick.source === "typesafe" && editedSinceFill.current) return;
    if (appliedFill?.picked) return;
    applyFill(entryFill.patterns[index], { force: false, picked: false, index, source: entryFill.pick.source });
    // applyFill reads the current form state; the pick is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryFill.patterns, entryFill.pick]);

  const chipVisible =
    entryFill.patterns !== null &&
    entryFill.patterns.length > 0 &&
    entryFill.pick !== null &&
    appliedFill !== null &&
    resolvedSelectedAccountId !== null;
  useEffect(() => {
    if (chipVisible) chipShown.current = true;
  }, [chipVisible]);

  /**
   * The record of what the user did with the fill, or null without one. It is
   * built before a save resets the form, and sent after.
   */
  const entryOutcome = (outcome: string) => {
    if (!entryFill.entryEnabled || !appliedFill) return null;
    return {
      evaluationId: entryFill.evaluationId,
      outcome,
      source: appliedFill.source,
      chipVisible: chipShown.current,
      pickedIndex: appliedFill.picked ? appliedFill.index : null,
      transactionId: null as number | null,
    };
  };
  /** Sends an outcome. It never blocks or undoes a save. */
  const sendEntryOutcome = (body: ReturnType<typeof entryOutcome>) => {
    if (!body) return;
    apiPost(`/api/b/${bookId}/entry-suggestion/outcome`, body).catch(() => undefined);
  };
  const postEntryOutcome = (outcome: string) => sendEntryOutcome(entryOutcome(outcome));

  // Closing the form with a fill and no save (the sheet's X, its backdrop,
  // leaving the page) records `abandoned`, as Cancel does. A close during a
  // save, or after a save that failed, records nothing: the user did not
  // abandon that entry. A save that is in flight sends its own outcome when
  // it succeeds.
  const abandoned = appliedFill !== null && !saving && appliedFill !== failedFill.current;
  const abandonOnUnmount = useRef<(() => void) | null>(null);
  useEffect(() => {
    abandonOnUnmount.current = abandoned ? () => postEntryOutcome("abandoned") : null;
  });
  useEffect(() => () => abandonOnUnmount.current?.(), []);

  const handleCancel = () => {
    if (abandoned) postEntryOutcome("abandoned");
    abandonOnUnmount.current = null;
    onCancel?.();
  };

  // The "usually $x–$y" hint of a pattern whose amount varies. In simple mode
  // it sits directly below the empty Amount field it is about, and describes
  // that field. Journal mode has no single amount field, so the hint stays
  // beside the chip there. The chip leaves the range out: in simple mode it
  // belongs under the Amount field only, and in journal mode the hint has it.
  const amountHint =
    chipVisible && appliedFill && mode === "simple" && simpleAmount === "" ? rangeHint(appliedFill.pattern) : null;
  const journalHint =
    chipVisible && appliedFill && mode === "journal" && appliedFill.fill.mode === "journal"
      ? rangeHint(appliedFill.pattern)
      : null;
  // Unique per form: the register can mount the desktop and mobile forms at
  // once. With fixed ids the second form's labels would name the first form's
  // fields, and its Amount field would point at the first form's hint.
  const fieldIdPrefix = useId();
  const fieldId = (name: string) => `${fieldIdPrefix}-${name}`;
  const amountHintId = fieldId("amount-hint");

  const renderEntryChip = () => {
    if (!chipVisible || !entryFill.patterns || !appliedFill || resolvedSelectedAccountId === null) return null;
    return (
      <EntryPatternChip
        patterns={entryFill.patterns}
        accounts={accounts}
        accountId={resolvedSelectedAccountId}
        chosen={appliedFill.pattern}
        source={
          appliedFill.picked
            ? "your pick"
            : appliedFill.source === "typesafe"
              ? "Clef"
              : entryFill.unsure
                ? "Clef was not sure"
                : "history"
        }
        hideAmount={mode === "simple" ? !appliedFill.pattern.stable : journalHint !== null}
        onPick={(pattern, index) =>
          pattern.key === appliedFill.pattern.key
            ? // The pattern already shown: an acceptance, not another pick.
              applyFill(pattern, {
                force: true,
                picked: appliedFill.picked,
                index: appliedFill.index,
                source: appliedFill.source,
              })
            : applyFill(pattern, { force: true, picked: true, index, source: appliedFill.source })
        }
      />
    );
  };

  const entryChip = renderEntryChip();

  const renderEntryHelp = () => {
    if (!entryChip) return null;
    return (
      <div className="mt-1 flex flex-wrap items-start gap-x-3 gap-y-1">
        {entryChip}
        {journalHint && <span className="text-xs text-fg-tertiary">{journalHint}</span>}
      </div>
    );
  };

  // Auto-fill To Account from last transaction for selected payee
  // It runs when the entry fill has no history in this account, or cannot
  // run (no register account).
  useEffect(() => {
    if (editingTransaction || mode !== "simple") return;
    if (entryActive && (entryFill.patterns === null || entryFill.patterns.length > 0)) return;

    if (!payeeName.trim()) {
      autoFilledPayeeId.current = null;
      return;
    }

    // The exact spelling first, then a case variant (matchedPayee).
    const matched = matchedPayee;
    if (!matched || autoFilledPayeeId.current === matched.id) return;

    const controller = new AbortController();
    apiGet<{ accountId?: number | null }>(
      `/api/b/${bookId}/payees/${matched.id}/last-account`,
      { signal: controller.signal }
    )
      .then((data) => {
        if (data?.accountId != null) {
          autoFilledPayeeId.current = matched.id;
          setToAccountId(data.accountId);
        }
      })
      .catch((err) => {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [bookId, payeeName, matchedPayee, editingTransaction, mode, entryActive, entryFill.patterns]);

  useEffect(() => {
    // Don't resolve account IDs when editing - preserve the original accounts even if inactive
    if (mode !== "simple" || editingTransaction) return;
    setFromAccountId((current) => {
      const next = resolveSimpleAccountId(current);
      return next === current ? current : next;
    });
    setToAccountId((current) => {
      const next = resolveSimpleAccountId(current);
      return next === current ? current : next;
    });
  }, [mode, resolveSimpleAccountId, editingTransaction]);

  // From goes to the register's account when the mode or the account changes.
  // An accounts refresh (a new resolveSimpleAccountId) keeps the user's From,
  // for example a money-in fill.
  const fromResetFor = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "simple" || editingTransaction || selectedAccountId === null) {
      fromResetFor.current = null;
      return;
    }
    const resolvedSelectedId = resolveSimpleAccountId(selectedAccountId);
    if (resolvedSelectedId === null) return;
    const key = `${mode}|${selectedAccountId}`;
    if (fromResetFor.current === key) return;
    fromResetFor.current = key;
    setFromAccountId(resolvedSelectedId);
  }, [mode, editingTransaction, selectedAccountId, resolveSimpleAccountId]);

  // Reset investment mode when navigating away from an investment account
  useEffect(() => {
    if (!isInvestmentAccountSelected && mode === "investment" && !editingTransaction) {
      setMode("simple");
      setInvestmentAccountId(null);
    }
  }, [isInvestmentAccountSelected, mode, editingTransaction, setInvestmentAccountId]);

  // Handle selecting newly created expense account after accounts list is refreshed
  useEffect(() => {
    if (investment.pendingNewAccountId !== null) {
      // Check if the new account is now in the accounts list
      const accountExists = accounts.some((account) => account.id === investment.pendingNewAccountId);
      if (accountExists) {
        // The user made this account: a later fill must not replace it.
        markAccountsTouched();
        setToAccountId(investment.pendingNewAccountId);
        setPendingNewAccountId(null);
      }
    }
  }, [accounts, investment.pendingNewAccountId, setPendingNewAccountId]);

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  );

  const hasBankAccountInvolved = useMemo(() => {
    if (mode === "simple") {
      const selectedIds = [fromAccountId, toAccountId].filter(
        (accountId): accountId is number => accountId !== null
      );
      return selectedIds.some(
        (accountId) => accountById.get(accountId)?.subtype === "bank"
      );
    }

    if (mode === "journal") {
      return splits.some(
        (split) => accountById.get(split.accountId)?.subtype === "bank"
      );
    }

    return false;
  }, [accountById, fromAccountId, mode, splits, toAccountId]);

  useEffect(() => {
    if (!hasBankAccountInvolved && checkNumber) {
      setCheckNumber("");
    }
  }, [hasBankAccountInvolved, checkNumber]);


  const handleExpenseCreated = useCallback(
    (accountId: number) => {
      // Store the pending account ID to be selected after accounts refresh
      setPendingNewAccountId(accountId);
      // Notify parent to refresh accounts
      if (onAccountsUpdate) {
        onAccountsUpdate();
      }
    },
    [setPendingNewAccountId, onAccountsUpdate]
  );

  // The splits of the entry in the current mode, or the message that says
  // why the entry is not valid.
  const buildModeEntry = (): EntryResult => {
    if (mode === "simple") {
      const resolvedAmount = resolveAmountOnBlur(simpleAmount);
      setSimpleAmount(resolvedAmount);
      return buildSimpleEntry(resolvedAmount, fromAccountId, toAccountId);
    }
    if (mode === "investment") {
      const message = investment.validate();
      return message ? { error: message } : investment.buildSplits();
    }
    if (hasPendingExpression) {
      return { error: "Please resolve all invalid amounts before saving" };
    }
    return { splits };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // A viewer's Enter key must not submit the form.
    if (readOnly) return;
    // The button, Enter and Ctrl/Cmd+Enter all come here. A submit during a
    // save is dropped, so one entry cannot be sent twice.
    void submitGuard.run(save);
  };

  // Checks the entry, sends it, and waits for the save handler. The part
  // before the first await runs in the submit gesture.
  const save = async () => {
    const entry = buildModeEntry();
    if ("error" in entry) {
      toast.error(entry.error);
      return;
    }

    if (!validateSplits(entry.splits)) {
      toast.error("Transaction must be balanced (debits must equal credits)");
      return;
    }

    // Warn if editing a reconciled transaction with material changes
    const changes = reconciledEditChanges(editingTransaction, date, entry.splits);
    if (changes.length > 0 && !confirm(reconciledEditPrompt(changes))) return;

    // Recorded only when the save handler reports success.
    const outcome = appliedFill
      ? entryOutcome(outcomeOf(appliedFill.fill, entry.splits, appliedFill.amountFilled, appliedFill.picked))
      : null;
    const saved = onSubmit(
      buildSubmitPayload(
        {
          date,
          description,
          notes,
          checkNumber,
          payeeName,
          isReconciled,
          isFloating,
          hasBankAccountInvolved,
        },
        entry
      )
    );
    // Made here, in the submit gesture, because browsers block audio that
    // starts later on its own. It plays only when the save handler reports
    // success.
    const playChord = prepareSaveChord();
    const fill = appliedFill;
    // The handler reports a failure with `false` or with a rejection. It
    // shows the reason itself.
    let result: void | boolean | number;
    try {
      result = await saved;
    } catch (error) {
      console.error("The save handler failed:", error);
      result = false;
    }
    if (result === false) {
      // The entry stays in the form, so the user can correct it or send it
      // again.
      failedFill.current = fill;
      return;
    }
    if (result === true || typeof result === "number") {
      // The saved id lets the report see which pattern was saved.
      if (outcome) sendEntryOutcome({ ...outcome, transactionId: typeof result === "number" ? result : null });
      playChord?.();
    }
    if (!editingTransaction) {
      resetFormRef.current();
      // Focus the payee field for immediate next entry. The effect below
      // does it, after the fields are enabled again.
      focusPayeeAfterSave.current = true;
      setSavedCount((count) => count + 1);
    }
  };

  // The fields are disabled during the save, and a disabled field cannot
  // take the focus. So the focus moves to Payee only in a render where the
  // save is over. `savedCount` makes sure that such a render comes.
  const focusPayeeAfterSave = useRef(false);
  const [savedCount, setSavedCount] = useState(0);
  useEffect(() => {
    if (saving || !focusPayeeAfterSave.current) return;
    focusPayeeAfterSave.current = false;
    payeeRef.current?.focus();
  }, [saving, savedCount]);

  const simpleAccountFilter = useCallback(
    (a: AccountWithBalance) => !(a.subtype === "investment" && !a.isInvestmentCash),
    []
  );
  const filteredSimpleAccounts = useMemo(
    () => accounts.filter(simpleAccountFilter),
    [accounts, simpleAccountFilter]
  );

  // --- Tab configuration ---
  const showInvestmentTab = isInvestmentAccountSelected || mode === "investment";

  const tabEntries: { id: TransactionMode; label: string }[] = [
    { id: "simple", label: "Simple" },
    { id: "journal", label: "Journal" },
    ...(showInvestmentTab
      ? [{ id: "investment" as TransactionMode, label: "Investment" }]
      : []),
  ];

  const renderTabBar = (isCompact: boolean) => (
    <div className="flex">
      {tabEntries.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => handleModeChange(tab.id)}
          aria-pressed={mode === tab.id}
          disabled={isEditing}
          className={`${
            isCompact ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm"
          } font-medium transition-colors border-b-2 ${
            mode === tab.id
              ? "border-accent text-fg-accent"
              : "border-transparent text-fg-tertiary hover:text-fg-secondary"
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  // --- Compact layout (new simple entry) ---
  if (compact) {
    return (
      <form ref={formRef} onSubmit={handleSubmit}>
        {/* The entry takes no input during the save: the save would not send
            it, and the reset after the save would erase it. */}
        <fieldset disabled={saving} className="min-w-0">
        {/* Tab bar + actions */}
        <div className="flex items-center justify-between border-b border-border">
          {renderTabBar(true)}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowNewExpense(!showNewExpense)}
              className="px-2 py-1 text-xs text-fg-accent hover:bg-accent-subtle rounded-md transition-colors whitespace-nowrap"
            >
              + Acct
            </button>
            <button
              type="button"
              onClick={() => setSecondaryExpanded((v) => !v)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-fg-tertiary hover:text-fg-secondary rounded-md hover:bg-surface-tertiary transition-colors"
              aria-label={secondaryExpanded ? "Hide details" : "Show details"}
            >
              <span>{secondaryExpanded ? "Less" : "More"}</span>
              <svg
                className={`w-3 h-3 transition-transform ${secondaryExpanded ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Simple mode */}
        {mode === "simple" && (
          <>
          {/* Column template mirrors the register's colgroup below, so each
              field sits over the column it fills and the column headers do the
              labelling -- the fields used to carry their own labels, forty
              pixels above an identical row of headers.

              Date needs ~9rem for an MM/DD/YYYY field and the register's date
              column is 5rem, so it borrows the difference back from Payee --
              that is what `calc(32% - 3.5rem)` is for. It used to borrow from
              the status gutter that led the register; the gutter now trails the
              numbers, so there is nothing in front of Date left to take.

              3.5rem is a fitted constant, not a derived one, and it cannot be
              exact. `table-fixed` hands its leftover width to the *px* columns
              in proportion to their declared widths, so the register's 5rem
              date column renders at 5rem only when the table is narrow enough
              to be over-subscribed, and wider than that otherwise (measured:
              80px at a 1200px viewport, 99px at 1440px). A grid track cannot
              follow that, so the ideal borrow moves with the viewport --
              64px narrow, 45px wide -- and 56px splits it: the Payee/Accounts
              boundary lands within ~11px of the register's across the desktop
              range. The previous 9rem was exact at 1440px and 30px out at
              1200px, so this trades an exact width for a bounded error.

              Add spans status plus balance plus actions. The two account fields
              share the Accounts column, as the register shares it between the
              accounts a transaction touches. */}
          <div className="grid grid-cols-[9rem_calc(32%-3.5rem)_24%_10rem_1fr] items-end pt-2 -mx-4">
          <div className={`pl-4 pr-2 ${isFloating ? "pointer-events-none" : ""}`} aria-disabled={isFloating || undefined} inert={isFloating || undefined}>
            <DateInput
              label="Date"
              labelHidden
              id={fieldId("date")}
              size="compact"
              value={isFloating ? toDateString(new Date()) : date}
              onChange={setDate}
              required
              className={isFloating ? "opacity-50" : ""}
            />
          </div>
          <div className="pr-2">
            <PayeeAutocomplete
              ref={payeeRef}
              payees={payeeSuggestions}
              textValue={payeeName}
              onTextChange={setPayeeName}
              label="Payee"
              labelHidden
              placeholder="Payee"
              size="compact"
              allowClear={false}
            />
          </div>
          <div className="flex items-end gap-1 min-w-0 pr-2">
            <AccountAutocomplete
              label="From Account"
              labelHidden
              accounts={filteredSimpleAccounts}
              value={fromAccountId}
              onChange={handleFromAccountChange}
              warning={selectedAccountMissing}
              placeholder="From..."
              showHierarchy={true}
              allowClear={false}
              size="compact"
            />
            <button
              type="button"
              onClick={() => {
                markAccountsTouched();
                setFromAccountId(toAccountId);
                setToAccountId(fromAccountId);
              }}
              className="mb-0.5 p-1 rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-tertiary transition-colors shrink-0"
              title="Swap accounts"
              aria-label="Swap From and To accounts"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </button>
            <AccountAutocomplete
              label="To Account"
              labelHidden
              accounts={filteredSimpleAccounts}
              value={toAccountId}
              onChange={handleToAccountChange}
              warning={selectedAccountMissing}
              placeholder="To..."
              showHierarchy={true}
              allowClear={false}
              size="compact"
            />
          </div>
          <div className="pr-2">
            <Input
              type="text"
              label="Amount"
              labelHidden
              id={fieldId("amount")}
              size="compact"
              value={simpleAmount}
              onChange={(e) => handleAmountChange(e.target.value)}
              onBlur={handleAmountBlur}
              onKeyDown={handleAmountKeyDown}
              placeholder="0.00"
              required
              selectOnFocus
              aria-describedby={amountHint ? amountHintId : undefined}
            />
          </div>
          {/* Labelled, and sized like the primary action it is. This was a bare
              "+" at size="sm" -- roughly 26x26px, the smallest control in a form
              it commits, and inconsistent with Journal and Investment modes,
              whose identical action is a full "Add Transaction" button. The
              aria-label stays: it contains the visible label, so it satisfies
              Label in Name, and it says which thing is being added.

              The box copies a compact Input: py-1, text-sm and a 1px border
              (transparent here) give the same 30px height, so the top and
              bottom edges align with the fields. The button keeps its natural
              width at the right edge. Full width stretched it across three
              register columns, wider than any field in the row. */}
          <div className="pr-4 flex justify-end">
            <Button
              ref={addButtonRef}
              type="submit"
              aria-label="Add Transaction"
              className="py-1 px-5 border border-transparent"
              disabled={saving}
            >
              Add
            </Button>
          </div>
          {/* A second row of the same grid: the chip under Date and Payee, and
              the range hint in the Amount column, directly below the field.
              Both are in flow, so the hint wraps inside its column and pushes
              what follows down rather than overlapping it. */}
          {entryChip && <div className="col-span-3 self-start pl-4 pr-2 mt-1">{entryChip}</div>}
          {amountHint && (
            <p id={amountHintId} className="col-start-4 self-start pl-2 pr-2 mt-1 text-xs text-fg-tertiary">
              {amountHint}
            </p>
          )}
        </div>
        {renderSelectedAccountWarning()}
        </>
        )}

        {/* Journal mode */}
        {mode === "journal" && (
          <div className="space-y-2 pt-2">
            <div className="grid grid-cols-[7rem_1fr] gap-2 items-end">
              <div className={isFloating ? "pointer-events-none" : ""} aria-disabled={isFloating || undefined} inert={isFloating || undefined}>
                <DateInput
                  label="Date"
                  id={fieldId("date")}
                  size="compact"
                  value={isFloating ? toDateString(new Date()) : date}
                  onChange={setDate}
                  required
                  className={isFloating ? "opacity-50" : ""}
                />
              </div>
              <PayeeAutocomplete
                ref={payeeRef}
                payees={payeeSuggestions}
                textValue={payeeName}
                onTextChange={setPayeeName}
                label="Payee"
                placeholder="Payee"
                size="compact"
                allowClear={false}
              />
            </div>
            {renderEntryHelp()}
            <SplitEditor
              splits={splits}
              onChange={handleSplitsChange}
              accounts={accounts}
              onPendingChange={setHasPendingExpression}
              submitRef={journalAddButtonRef}
            />
            <div className="flex justify-end">
              <Button ref={journalAddButtonRef} type="submit" size="sm" disabled={saving}>
                Add Transaction
                <span className="ml-1.5 text-xs opacity-60" aria-hidden="true">
                  {typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+↵
                </span>
              </Button>
            </div>
          </div>
        )}

        {/* Investment mode */}
        {mode === "investment" && (
          <div className="space-y-2 pt-2">
            <div className="grid grid-cols-[7rem_1fr_1fr_1fr_1fr] gap-2 items-end">
              <div className={isFloating ? "pointer-events-none" : ""} aria-disabled={isFloating || undefined} inert={isFloating || undefined}>
                <DateInput
                  label="Date"
                  id={fieldId("date")}
                  size="compact"
                  value={isFloating ? toDateString(new Date()) : date}
                  onChange={setDate}
                  required
                  className={isFloating ? "opacity-50" : ""}
                />
              </div>
              <PayeeAutocomplete
                ref={payeeRef}
                payees={payeeSuggestions}
                textValue={payeeName}
                onTextChange={setPayeeName}
                label="Payee"
                placeholder="Payee"
                size="compact"
                allowClear={false}
              />
              <InvestmentEntrySection investment={investment} accounts={accounts} compact />
            </div>
          </div>
        )}

        {/* Collapsible details */}
        {secondaryExpanded && (
          <div className="space-y-1 pt-2">
            <div className={`grid gap-2 items-end ${hasBankAccountInvolved ? "grid-cols-[1fr_7rem]" : ""}`}>
              <Input
                ref={descriptionRef}
                type="text"
                label="Description"
                id={fieldId("description")}
                size="compact"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
              />
              {hasBankAccountInvolved && (
                <Input
                  type="text"
                  label="Check #"
                  id={fieldId("checkNumber")}
                  size="compact"
                  value={checkNumber}
                  onChange={(e) => setCheckNumber(e.target.value)}
                  placeholder="Check #"
                  maxLength={32}
                />
              )}
            </div>
            <Textarea
              label="Notes"
              id={fieldId("notes-compact")}
              size="compact"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (markdown supported)"
              rows={2}
            />
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer" title="Transaction date auto-advances to today until reconciled">
                <input
                  type="checkbox"
                  checked={isFloating}
                  onChange={(e) => {
                    setIsFloating(e.target.checked);
                    if (e.target.checked && isReconciled) {
                      setIsReconciled(false);
                    }
                  }}
                  className="rounded text-fg-accent focus:ring-fg-accent"
                />
                Float (date advances to today until reconciled)
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={isReconciled}
                  onChange={(e) => {
                    setIsReconciled(e.target.checked);
                    if (e.target.checked && isFloating) {
                      setIsFloating(false);
                    }
                  }}
                  className="rounded text-fg-success focus:ring-fg-success"
                />
                Reconciled
              </label>
            </div>
          </div>
        )}

        <NewExpenseSubflow
          accounts={accounts}
          isOpen={showNewExpense}
          onToggle={() => setShowNewExpense(!showNewExpense)}
          onCreated={handleExpenseCreated}
          compact
          name={newExpenseName}
          onNameChange={setNewExpenseName}
          parentId={newExpenseParentId}
          onParentIdChange={setNewExpenseParentId}
          isCreating={isCreatingExpense}
          onCreatingChange={setIsCreatingExpense}
        />
        </fieldset>
      </form>
    );
  }

  // --- Full layout (editing, journal, investment modes) ---
  return (
    <>
      {plaidData && editingTransaction && onPlaidUnlinked && (
        <PlaidBanner
          plaidData={plaidData}
          bookId={bookId}
          transactionId={editingTransaction.id}
          onUnlinked={onPlaidUnlinked}
          readOnly={readOnly}
        />
      )}
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
      {/* Disabled for a viewer, and during the save: the save would not send
          later input, and the reset after the save would erase it. */}
      <fieldset disabled={readOnly || saving} className="space-y-4 min-w-0">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-fg-secondary">
          {editingTransaction ? "Edit Transaction" : "New Transaction"}
        </h3>
        {renderTabBar(false)}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Input
            type="date"
            label="Date"
            id={fieldId("date")}
            value={isFloating ? toDateString(new Date()) : date}
            onChange={(e) => setDate(e.target.value)}
            required
            disabled={isFloating}
            className={isFloating ? "opacity-50" : ""}
          />
          <label className="flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer" title="Transaction date auto-advances to today until reconciled">
            <input
              type="checkbox"
              checked={isFloating}
              onChange={(e) => {
                setIsFloating(e.target.checked);
                if (e.target.checked && isReconciled) {
                  setIsReconciled(false);
                }
              }}
              className="rounded text-fg-accent focus:ring-fg-accent"
            />
            Float (date advances to today until reconciled)
          </label>
        </div>
        <PayeeAutocomplete
          ref={payeeRef}
          payees={payeeSuggestions}
          textValue={payeeName}
          onTextChange={setPayeeName}
          label="Payee"
          placeholder="e.g., Whole Foods"
          allowClear={false}
        />
        {renderEntryHelp()}
      </div>

      <button
        type="button"
        onClick={() => setSecondaryExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${secondaryExpanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span>Description, notes{hasBankAccountInvolved ? ", check #" : ""}</span>
      </button>

      {secondaryExpanded && (
        <>
          <div
            className={`grid grid-cols-1 gap-4 ${hasBankAccountInvolved ? "md:grid-cols-[2fr_1fr]" : "md:grid-cols-1"}`}
          >
            <Input
              ref={descriptionRef}
              type="text"
              label="Description"
              id={fieldId("description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Grocery shopping"
            />
            {hasBankAccountInvolved && (
              <Input
                type="text"
                label="Check Number (optional)"
                id={fieldId("checkNumber")}
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="e.g., 1234"
                maxLength={32}
              />
            )}
          </div>

          <Textarea
            label="Notes (optional)"
            id={fieldId("notes")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add notes (markdown supported)"
            rows={3}
          />
        </>
      )}

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={isReconciled}
            onChange={(e) => {
              setIsReconciled(e.target.checked);
              if (e.target.checked && isFloating) {
                setIsFloating(false);
                if (editingTransaction) {
                  setDate(toDateString(new Date()));
                }
              }
            }}
            className="rounded text-fg-success focus:ring-fg-success"
          />
          Reconciled
        </label>
        {editingTransaction?.isFloating && isReconciled && !editingTransaction.isReconciled && (
          <div className="ml-6">
            <DateInput
              label="Cleared date"
              id={fieldId("clearedDate")}
              size="compact"
              value={date}
              onChange={setDate}
            />
          </div>
        )}
      </div>

      {mode === "simple" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto_1fr_1fr] gap-4 items-end">
            <AccountAutocomplete
              label="From Account"
              accounts={filteredSimpleAccounts}
              value={fromAccountId}
              onChange={handleFromAccountChange}
              warning={selectedAccountMissing}
              placeholder="Search for account..."
              showHierarchy={true}
              allowClear={false}

            />
            <button
              type="button"
              onClick={() => {
                markAccountsTouched();
                setFromAccountId(toAccountId);
                setToAccountId(fromAccountId);
              }}
              className="mb-0.5 p-1.5 rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-tertiary transition-colors"
              title="Swap accounts"
              aria-label="Swap From and To accounts"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </button>
            <AccountAutocomplete
              label="To Account"
              accounts={filteredSimpleAccounts}
              value={toAccountId}
              onChange={handleToAccountChange}
              warning={selectedAccountMissing}
              placeholder="Search for account..."
              showHierarchy={true}
              allowClear={false}

            />
            <Input
              type="text"
              label="Amount"
              id={fieldId("amount")}
              value={simpleAmount}
              onChange={(e) => handleAmountChange(e.target.value)}
              onBlur={handleAmountBlur}
              placeholder="0.00"
              required
              selectOnFocus
              aria-describedby={amountHint ? amountHintId : undefined}
            />
            {amountHint && (
              <p id={amountHintId} className="col-start-4 -mt-3 text-xs text-fg-tertiary">
                {amountHint}
              </p>
            )}
          </div>
          {renderSelectedAccountWarning()}
          <button
            type="button"
            onClick={() => setShowNewExpense(!showNewExpense)}
            className="text-xs text-fg-accent hover:text-fg-accent"
          >
            + New Expense Account
          </button>

          <NewExpenseSubflow
            accounts={accounts}
            isOpen={showNewExpense}
            onToggle={() => setShowNewExpense(!showNewExpense)}
            onCreated={handleExpenseCreated}
            compact={false}
            name={newExpenseName}
            onNameChange={setNewExpenseName}
            parentId={newExpenseParentId}
            onParentIdChange={setNewExpenseParentId}
            isCreating={isCreatingExpense}
            onCreatingChange={setIsCreatingExpense}
          />
        </div>
      ) : mode === "journal" ? (
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-2">
            Journal Entry
          </label>
          {(editingTransaction?.investmentSplits?.length ?? 0) > 0 && (
            <p className="text-xs text-fg-tertiary mb-2">
              This transaction also has{" "}
              {editingTransaction?.investmentSplits.length === 1
                ? "1 investment split"
                : `${editingTransaction?.investmentSplits.length} investment splits`}
              . A save keeps them as they are.
            </p>
          )}
          <SplitEditor
            splits={splits}
            onChange={handleSplitsChange}
            accounts={accounts}
            onPendingChange={setHasPendingExpression}
          />
        </div>
      ) : (
        <InvestmentEntrySection investment={investment} accounts={accounts} compact={false} />
      )}
      </fieldset>

      {editingTransaction && (
        <TransactionAuthorship createdBy={editingTransaction.createdBy} updatedBy={editingTransaction.updatedBy} />
      )}

      <div className="flex justify-between pt-4 border-t">
        {readOnly ? (
          <div className="flex w-full justify-end">
            {onCancel && (
              <Button type="button" variant="secondary" onClick={onCancel}>
                Close
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex gap-3">
              {editingTransaction && onDelete && (
                <Button type="button" variant="danger" onClick={onDelete} disabled={saving}>
                  Delete
                </Button>
              )}
              {/* A recurring rule copies only the ledger splits, so a
                  transaction with investment splits cannot become one. A
                  transaction with more than one opens in journal mode. */}
              {editingTransaction &&
                (editingTransaction.investmentSplits?.length ?? 0) === 0 &&
                onMakeRecurring && (
                <Button type="button" variant="secondary" onClick={() => onMakeRecurring(editingTransaction.id)} disabled={saving}>
                  Make recurring...
                </Button>
              )}
            </div>
            <div className="flex gap-3">
              {onCancel && (
                <Button type="button" variant="secondary" onClick={handleCancel}>
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={saving}>
                {editingTransaction ? "Save Changes" : "Add Transaction"}
                {!editingTransaction && (
                  <span className="ml-1.5 text-xs opacity-60" aria-hidden="true">
                    {typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+↵
                  </span>
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </form>
    </>
  );
});
