"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useImperativeHandle, forwardRef } from "react";
import { useBookId } from "@/hooks/useBookId";
import { apiGet } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DateInput } from "@/components/ui/DateInput";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { Textarea } from "@/components/ui/Textarea";
import { SplitEditor } from "./SplitEditor";
import {
  toDateString,
  parseStrictCurrency,
  resolveAmountOnBlur,
  getAccountShortName,
} from "@/lib/formatters";
import { validateSplits } from "@/lib/accounting";
import type {
  AccountWithBalance,
  InvestmentSplitInput,
  PlaidLinkData,
  SplitInput,
  TransactionWithSplits,
} from "@/types";
import { PlaidBanner } from "./PlaidBanner";
import { useInvestmentEntry } from "./useInvestmentEntry";
import { InvestmentEntrySection } from "./InvestmentEntrySection";
import { NewExpenseSubflow } from "./NewExpenseSubflow";

interface TransactionFormProps {
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  editingTransaction?: TransactionWithSplits | null;
  plaidData?: PlaidLinkData | null;
  onPlaidUnlinked?: () => void;
  onSubmit: (data: {
    date: string;
    description: string;
    notes?: string;
    checkNumber?: string;
    payeeName?: string;
    isReconciled?: boolean;
    isFloating?: boolean;
    splits: SplitInput[];
    investmentSplits?: InvestmentSplitInput[];
  }) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onMakeRecurring?: (transactionId: number) => void;
  onAccountsUpdate?: () => void;
  isInvestmentAccountSelected?: boolean;
  fullLayout?: boolean;
}

type TransactionMode = "simple" | "journal" | "investment";

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
  const autoFilledPayeeId = useRef<number | null>(null);

  const compact = !fullLayout && !editingTransaction;

  useImperativeHandle(ref, () => ({
    focus: () => {
      payeeRef.current?.focus();
    },
  }));

  // Ctrl/Cmd+Enter to submit from anywhere in the form
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

  const formatMicrosInput = (value: number) => {
    const formatted = (value / 1_000_000).toFixed(6);
    return formatted.replace(/\.?0+$/, "");
  };

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
  const handleFromAccountChange = (id: number | null) => {
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
          className="h-3.5 w-3.5 flex-shrink-0"
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

  const isEditing = Boolean(editingTransaction);

  const handleModeChange = (nextMode: TransactionMode) => {
    if (isEditing) return;
    setMode(nextMode);
    if (nextMode === "journal") {
      setSplits([
        { accountId: selectedAccountId || 0, amount: 0 },
        { accountId: 0, amount: 0 },
      ]);
    }
  };

  useEffect(() => {
    if (editingTransaction) {
      setDate(editingTransaction.date);
      setDescription(editingTransaction.description || "");
      setCheckNumber(editingTransaction.checkNumber || "");
      setNotes(editingTransaction.notes || "");
      setPayeeName(editingTransaction.payee?.name || "");
      setIsReconciled(editingTransaction.isReconciled);
      setIsFloating(editingTransaction.isFloating);
      setSecondaryExpanded(true);
      setSplits(
        editingTransaction.splits.map((s) => ({
          accountId: s.accountId,
          amount: s.amount,
        }))
      );
      setMode(editingTransaction.splits.length === 2 ? "simple" : "journal");
      if (editingTransaction.splits.length === 2) {
        const debitSplit = editingTransaction.splits.find((s) => s.amount > 0);
        const creditSplit = editingTransaction.splits.find((s) => s.amount < 0);
        if (debitSplit && creditSplit) {
          setSimpleAmount((debitSplit.amount / 100).toFixed(2));
          setToAccountId(debitSplit.accountId);
          setFromAccountId(creditSplit.accountId);
        }
      }

      if (editingTransaction.investmentSplits?.length) {
        const investmentSplit = editingTransaction.investmentSplits[0];
        setMode("investment");
        investment.setSelectedSecurityId(investmentSplit.securityId);
        investment.setInvestmentAction(investmentSplit.action);
        investment.setInvestmentShares(formatMicrosInput(investmentSplit.sharesMicros));
        investment.setInvestmentPrice(formatMicrosInput(investmentSplit.priceMicros));
        investment.setInvestmentFee(((investmentSplit.feesCents ?? 0) / 100).toFixed(2));
        investment.setInvestmentSplitNumerator(
          investmentSplit.splitNumerator ? String(investmentSplit.splitNumerator) : ""
        );
        investment.setInvestmentSplitDenominator(
          investmentSplit.splitDenominator ? String(investmentSplit.splitDenominator) : ""
        );

        const investmentAccount = editingTransaction.splits.find(
          (split) => split.account.subtype === "investment"
        );
        const investmentCashAccount = editingTransaction.splits.find(
          (split) => split.account.isInvestmentCash
        );

        // For dividend transactions, set the dividend amount from the cash account split
        if (investmentSplit.action === "dividend" && investmentCashAccount) {
          investment.setInvestmentDividendAmount((investmentCashAccount.amount / 100).toFixed(2));
        }
        // For capital gain transactions, set the capital gain amount from the cash account split
        if (investmentSplit.action === "capGain" && investmentCashAccount) {
          investment.setInvestmentCapGainAmount((investmentCashAccount.amount / 100).toFixed(2));
        }
        const incomeAccount = editingTransaction.splits.find(
          (split) => split.account.type === "income"
        );
        const expenseAccount = editingTransaction.splits.find(
          (split) => split.account.type === "expense"
        );

        if (investmentAccount) {
          investment.setInvestmentAccountId(investmentAccount.accountId);
        } else if (investmentCashAccount?.account.parentId) {
          investment.setInvestmentAccountId(investmentCashAccount.account.parentId);
        }
        if (incomeAccount) {
          investment.setInvestmentIncomeAccountId(incomeAccount.accountId);
        }
        if (expenseAccount) {
          investment.setInvestmentFeeAccountId(expenseAccount.accountId);
        }
      }
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
    }, 150);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [bookId, payeeName]);

  // Auto-fill To Account from last transaction for selected payee
  useEffect(() => {
    if (editingTransaction || mode !== "simple") return;

    const trimmed = payeeName.trim();
    if (!trimmed) {
      autoFilledPayeeId.current = null;
      return;
    }

    const matched = payeeSuggestions.find(
      (s) => s.name.toLowerCase() === trimmed.toLowerCase()
    );
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
  }, [bookId, payeeName, payeeSuggestions, editingTransaction, mode]);

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

  useEffect(() => {
    if (mode !== "simple" || editingTransaction || selectedAccountId === null) return;
    const resolvedSelectedId = resolveSimpleAccountId(selectedAccountId);
    if (resolvedSelectedId !== null) {
      setFromAccountId(resolvedSelectedId);
    }
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let finalSplits: SplitInput[];
    let investmentSplits: InvestmentSplitInput[] | undefined;

    if (mode === "simple") {
      const resolvedAmount = resolveAmountOnBlur(simpleAmount);
      setSimpleAmount(resolvedAmount);
      const amount = parseStrictCurrency(resolvedAmount);
      if (!fromAccountId || !toAccountId) {
        toast.error("Please select both accounts");
        return;
      }
      if (amount === null) {
        toast.error("Please enter a valid amount");
        return;
      }
      if (amount <= 0) {
        toast.error("Please enter an amount");
        return;
      }

      // Debit the "to" account, credit the "from" account
      finalSplits = [
        { accountId: toAccountId, amount: amount },
        { accountId: fromAccountId, amount: -amount },
      ];
    } else if (mode === "investment") {
      const message = investment.validate();
      if (message) {
        toast.error(message);
        return;
      }

      const built = investment.buildSplits();
      finalSplits = built.splits;
      investmentSplits = built.investmentSplits;
    } else {
      if (hasPendingExpression) {
        toast.error("Please resolve all invalid amounts before saving");
        return;
      }
      finalSplits = splits;
    }

    if (!validateSplits(finalSplits)) {
      toast.error("Transaction must be balanced (debits must equal credits)");
      return;
    }

    // Warn if editing a reconciled transaction with material changes
    if (editingTransaction?.isReconciled) {
      const origSplits = editingTransaction.splits;
      const dateChanged = date !== editingTransaction.date;

      // Compare splits by sorting both arrays by accountId then amount
      const normalize = (s: { accountId: number; amount: number }[]) =>
        [...s].sort((a, b) => a.accountId - b.accountId || a.amount - b.amount);
      const origNorm = normalize(origSplits);
      const newNorm = normalize(finalSplits);
      const splitsChanged =
        origNorm.length !== newNorm.length ||
        origNorm.some(
          (s, i) =>
            s.accountId !== newNorm[i].accountId ||
            s.amount !== newNorm[i].amount
        );

      if (dateChanged || splitsChanged) {
        const changes: string[] = [];
        if (dateChanged) changes.push("date");
        if (splitsChanged) changes.push("amount/accounts");
        const ok = confirm(
          `This transaction is reconciled. You are changing its ${changes.join(" and ")}.\n\nSave anyway?`
        );
        if (!ok) return;
      }
    }

    const normalizedCheckNumber = checkNumber.trim();
    onSubmit({
      date,
      description,
      ...(notes.trim() && { notes: notes.trim() }),
      ...(hasBankAccountInvolved && { checkNumber: normalizedCheckNumber }),
      payeeName: payeeName.trim(),
      isReconciled,
      isFloating,
      splits: finalSplits,
      investmentSplits,
    });
    if (!editingTransaction) {
      resetForm();
      // Focus the payee field for immediate next entry
      requestAnimationFrame(() => {
        payeeRef.current?.focus();
      });
    }
  };

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
          <div className="grid grid-cols-[7rem_1fr_1fr_auto_1fr_7rem_auto] gap-2 items-end pt-2">
          <div className={isFloating ? "pointer-events-none" : ""} aria-disabled={isFloating || undefined} inert={isFloating || undefined}>
            <DateInput
              label="Date"
              id="date"
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
          <AccountAutocomplete
            label="From Account"
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
              setFromAccountId(toAccountId);
              setToAccountId(fromAccountId);
            }}
            className="mb-0.5 p-1 rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-tertiary transition-colors"
            title="Swap accounts"
            aria-label="Swap From and To accounts"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          </button>
          <AccountAutocomplete
            label="To Account"
            accounts={filteredSimpleAccounts}
            value={toAccountId}
            onChange={handleToAccountChange}
            warning={selectedAccountMissing}
            placeholder="To..."
            showHierarchy={true}
            allowClear={false}

            size="compact"
          />
          <Input
            type="text"
            label="Amount"
            id="amount"
            size="compact"
            value={simpleAmount}
            onChange={(e) => setSimpleAmount(e.target.value)}
            onBlur={() => {
              setSimpleAmount(resolveAmountOnBlur(simpleAmount));
            }}
            placeholder="0.00"
            required
            selectOnFocus
          />
          <Button type="submit" size="sm" aria-label="Add Transaction" className="mb-px">
            +
          </Button>
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
                  id="date"
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
            <SplitEditor
              splits={splits}
              onChange={setSplits}
              accounts={accounts}
              onPendingChange={setHasPendingExpression}
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm">
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
                  id="date"
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
                id="description"
                size="compact"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
              />
              {hasBankAccountInvolved && (
                <Input
                  type="text"
                  label="Check #"
                  id="checkNumber"
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
              id="notes-compact"
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
        />
      )}
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
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
            id="date"
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
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Grocery shopping"
            />
            {hasBankAccountInvolved && (
              <Input
                type="text"
                label="Check Number (optional)"
                id="checkNumber"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="e.g., 1234"
                maxLength={32}
              />
            )}
          </div>

          <Textarea
            label="Notes (optional)"
            id="notes"
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
              id="clearedDate"
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
              id="amount"
              value={simpleAmount}
              onChange={(e) => setSimpleAmount(e.target.value)}
              onBlur={() => {
                setSimpleAmount(resolveAmountOnBlur(simpleAmount));
              }}
              placeholder="0.00"
              required
              selectOnFocus
            />
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
          <SplitEditor
            splits={splits}
            onChange={setSplits}
            accounts={accounts}
            onPendingChange={setHasPendingExpression}
          />
        </div>
      ) : (
        <InvestmentEntrySection investment={investment} accounts={accounts} compact={false} />
      )}

      <div className="flex justify-between pt-4 border-t">
        <div className="flex gap-3">
          {editingTransaction && onDelete && (
            <Button type="button" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          )}
          {editingTransaction && mode !== "investment" && onMakeRecurring && (
            <Button type="button" variant="secondary" onClick={() => onMakeRecurring(editingTransaction.id)}>
              Make recurring...
            </Button>
          )}
        </div>
        <div className="flex gap-3">
          {onCancel && (
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit">
            {editingTransaction ? "Save Changes" : "Add Transaction"}
            {!editingTransaction && (
              <span className="ml-1.5 text-xs opacity-60" aria-hidden="true">
                {typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+↵
              </span>
            )}
          </Button>
        </div>
      </div>
    </form>
    </>
  );
});
