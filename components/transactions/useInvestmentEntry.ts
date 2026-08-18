"use client";

import { useEffect, useMemo, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { apiGet } from "@/lib/api-client";
import { formatPriceMicrosInput, parseStrictCurrency } from "@/lib/formatters";
import { evaluateExpression } from "@/lib/expression";
import {
  buildBuySplits,
  buildCapGainSplits,
  buildDividendSplits,
  buildSellSplits,
  getInvestmentGrossAmountCents,
} from "@/lib/accounting";
import type {
  AccountWithBalance,
  InvestmentSplitInput,
  SplitInput,
  TransactionWithSplits,
} from "@/types";

interface Security {
  id: number;
  name: string;
  symbol: string;
  securityType: string;
  fixedPriceMicros?: number | null;
}

export type InvestmentAction =
  | "buy"
  | "sell"
  | "dividend"
  | "capGain"
  | "fee"
  | "split";

export interface InvestmentEntry {
  // state + setters the section renders from
  securities: Security[];
  investmentAccountId: number | null;
  setInvestmentAccountId: (id: number | null) => void;
  investmentIncomeAccountId: number | null;
  setInvestmentIncomeAccountId: (id: number | null) => void;
  investmentFeeAccountId: number | null;
  setInvestmentFeeAccountId: (id: number | null) => void;
  selectedSecurityId: number | null;
  setSelectedSecurityId: (id: number | null) => void;
  /**
   * Pick a security the way a user does. Unlike the bare setter, this fills in
   * the price of a fixed-price security — which is why the two are separate:
   * restoring a saved transaction uses the setter and must keep the price it
   * was recorded at.
   */
  selectSecurity: (id: number | null) => void;
  selectedSecurity: Security | null;
  investmentAction: InvestmentAction;
  setInvestmentAction: (a: InvestmentAction) => void;
  investmentShares: string;
  setInvestmentShares: (v: string) => void;
  investmentPrice: string;
  setInvestmentPrice: (v: string) => void;
  investmentFee: string;
  setInvestmentFee: (v: string) => void;
  investmentDividendAmount: string;
  setInvestmentDividendAmount: (v: string) => void;
  investmentCapGainAmount: string;
  setInvestmentCapGainAmount: (v: string) => void;
  investmentSplitNumerator: string;
  setInvestmentSplitNumerator: (v: string) => void;
  investmentSplitDenominator: string;
  setInvestmentSplitDenominator: (v: string) => void;
  pendingNewAccountId: number | null;
  setPendingNewAccountId: (id: number | null) => void;

  // derived
  investmentCashAccountId: number | null;
  investmentTotal: { grossAmount: number; totalCents: number };

  // behaviour
  validate: () => string | null; // null = valid; otherwise the message to toast
  buildSplits: () => { splits: SplitInput[]; investmentSplits: InvestmentSplitInput[] };
  reset: () => void;
}

export function useInvestmentEntry(args: {
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  editingTransaction?: TransactionWithSplits | null;
}): InvestmentEntry {
  const { accounts, selectedAccountId, editingTransaction } = args;

  const bookId = useBookId();

  const [securities, setSecurities] = useState<Security[]>([]);
  const [investmentAccountId, setInvestmentAccountId] = useState<number | null>(null);
  const [investmentIncomeAccountId, setInvestmentIncomeAccountId] = useState<number | null>(
    null
  );
  const [investmentFeeAccountId, setInvestmentFeeAccountId] = useState<number | null>(
    null
  );
  const [selectedSecurityId, setSelectedSecurityId] = useState<number | null>(null);
  const [investmentAction, setInvestmentAction] = useState<
    "buy" | "sell" | "dividend" | "capGain" | "fee" | "split"
  >("buy");
  const [investmentShares, setInvestmentShares] = useState("");
  const [investmentPrice, setInvestmentPrice] = useState("");
  const [investmentFee, setInvestmentFee] = useState("");
  const [investmentDividendAmount, setInvestmentDividendAmount] = useState("");
  const [investmentCapGainAmount, setInvestmentCapGainAmount] = useState("");
  const [investmentSplitNumerator, setInvestmentSplitNumerator] = useState("");
  const [investmentSplitDenominator, setInvestmentSplitDenominator] = useState("");
  const [pendingNewAccountId, setPendingNewAccountId] = useState<number | null>(null);

  const parseMicrosInput = (value: string) => {
    const evaluated = evaluateExpression(value);
    if (evaluated !== null) return Math.round(evaluated * 1_000_000);
    // Strict numeric fallback for inputs evaluateExpression rejects
    // (e.g. "5."). Reject partial prefixes like "100/" or "1e6"
    // that parseFloat would otherwise silently coerce.
    const trimmed = value.trim();
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return 0;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed * 1_000_000);
  };

  const selectedSecurity =
    securities.find((security) => security.id === selectedSecurityId) ?? null;

  const selectSecurity = (id: number | null) => {
    const previous = securities.find(
      (candidate) => candidate.id === selectedSecurityId
    );
    const next = securities.find((candidate) => candidate.id === id);
    setSelectedSecurityId(id);

    if (next?.fixedPriceMicros != null) {
      setInvestmentPrice(formatPriceMicrosInput(next.fixedPriceMicros));
      return;
    }

    // Moving off a fixed-price security: the NAV this form filled in belongs to
    // the fund, not to whatever was picked next. Only our own auto-fill is
    // dropped — a price the user typed survives a security change, as it does
    // everywhere else in this form.
    if (
      previous?.fixedPriceMicros != null &&
      investmentPrice === formatPriceMicrosInput(previous.fixedPriceMicros)
    ) {
      setInvestmentPrice("");
    }
  };

  const parseCentsInput = (value: string): number => {
    const evaluated = evaluateExpression(value);
    if (evaluated !== null) return Math.round(evaluated * 100);
    return parseStrictCurrency(value) ?? 0;
  };

  useEffect(() => {
    const loadSecurities = async () => {
      try {
        const data = await apiGet<Security[]>(`/api/b/${bookId}/securities`);
        setSecurities(Array.isArray(data) ? data : []);
      } catch {
        // Securities feed the investment-mode autocomplete only; a failed
        // fetch just leaves it empty (like a never-loaded state) and the
        // rest of the form remains usable.
      }
    };

    void loadSecurities();
  }, [bookId]);

  useEffect(() => {
    const investmentAccounts = accounts.filter(
      (account) =>
        account.type === "asset" &&
        account.subtype === "investment" &&
        account.isActive
    );
    const incomeAccounts = accounts.filter((account) => account.type === "income");
    const expenseAccounts = accounts.filter((account) => account.type === "expense");

    if (!editingTransaction) {
      // Check if selectedAccountId is an investment account
      const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
      const isSelectedInvestment =
        selectedAccount?.type === "asset" &&
        selectedAccount?.subtype === "investment" &&
        selectedAccount?.isActive;

      // If selectedAccountId is an investment account, always use it
      // Otherwise, only set if not already set
      if (isSelectedInvestment) {
        if (investmentAccountId !== selectedAccountId) {
          setInvestmentAccountId(selectedAccountId);
        }
      } else if (!investmentAccountId && investmentAccounts.length > 0) {
        setInvestmentAccountId(investmentAccounts[0].id);
      }

      if (!investmentIncomeAccountId && incomeAccounts.length > 0) {
        setInvestmentIncomeAccountId(incomeAccounts[0].id);
      }
      if (!investmentFeeAccountId && expenseAccounts.length > 0) {
        setInvestmentFeeAccountId(expenseAccounts[0].id);
      }
    }
  }, [
    accounts,
    editingTransaction,
    investmentAccountId,
    investmentFeeAccountId,
    investmentIncomeAccountId,
    selectedAccountId,
  ]);

  const investmentCashAccountId = useMemo(() => {
    if (!investmentAccountId) return null;
    return (
      accounts.find(
        (account) =>
          account.parentId === investmentAccountId &&
          account.isInvestmentCash &&
          account.isActive
      )?.id ?? null
    );
  }, [accounts, investmentAccountId]);

  const investmentTotal = useMemo(() => {
    const sharesMicros = parseMicrosInput(investmentShares);
    const priceMicros = parseMicrosInput(investmentPrice);
    const feesCents = parseCentsInput(investmentFee);
    const grossAmount = getInvestmentGrossAmountCents(sharesMicros, priceMicros);
    const dividendAmountCents = parseCentsInput(investmentDividendAmount);
    const capGainAmountCents = parseCentsInput(investmentCapGainAmount);

    let totalCents = grossAmount;
    switch (investmentAction) {
      case "buy":
        totalCents = grossAmount + feesCents;
        break;
      case "sell":
        totalCents = grossAmount - feesCents;
        break;
      case "dividend":
        totalCents = dividendAmountCents;
        break;
      case "capGain":
        totalCents = capGainAmountCents;
        break;
      case "fee":
        totalCents = feesCents > 0 ? feesCents : grossAmount;
        break;
      default:
        totalCents = grossAmount;
        break;
    }

    return { grossAmount, totalCents };
  }, [investmentAction, investmentFee, investmentPrice, investmentShares, investmentDividendAmount, investmentCapGainAmount]);

  const validate = (): string | null => {
    if (!selectedSecurityId) {
      return "Please select a security";
    }

    const isSplitAction = investmentAction === "split";
    const sharesMicros = isSplitAction ? 0 : parseMicrosInput(investmentShares);
    const priceMicros = isSplitAction ? 0 : parseMicrosInput(investmentPrice);
    const feesCents = isSplitAction ? 0 : parseCentsInput(investmentFee);
    const grossAmount = getInvestmentGrossAmountCents(sharesMicros, priceMicros);
    const splitNumeratorInput = investmentSplitNumerator.trim();
    const splitDenominatorInput = investmentSplitDenominator.trim();
    const splitNumerator = isSplitAction ? Number(splitNumeratorInput) : undefined;
    const splitDenominator = isSplitAction ? Number(splitDenominatorInput) : undefined;

    if (
      ["buy", "sell"].includes(investmentAction) &&
      (sharesMicros <= 0 || priceMicros <= 0)
    ) {
      return "Shares and price are required for this investment action";
    }

    if (investmentAction === "dividend") {
      const dividendAmount = parseCentsInput(investmentDividendAmount);
      if (dividendAmount <= 0) {
        return "Dividend amount is required";
      }
    }

    if (investmentAction === "capGain") {
      const capGainAmount = parseCentsInput(investmentCapGainAmount);
      if (capGainAmount <= 0) {
        return "Capital gain amount is required";
      }
    }

    if (investmentAction === "split") {
      const wholeNumberPattern = /^\d+$/;
      if (
        !wholeNumberPattern.test(splitNumeratorInput) ||
        !wholeNumberPattern.test(splitDenominatorInput)
      ) {
        return "Split ratio must be whole numbers";
      }
      if (splitNumerator! <= 0 || splitDenominator! <= 0) {
        return "Split ratio must be greater than zero";
      }
    }

    if (investmentAction === "fee" && feesCents <= 0 && grossAmount <= 0) {
      return "Fee amount is required for a fee action";
    }

    if (!investmentAccountId) {
      return "Please select an investment account";
    }

    if (!investmentCashAccountId) {
      return "No cash account found for the selected investment account";
    }

    if (investmentAction === "buy" || investmentAction === "sell") {
      if (feesCents > 0 && !investmentFeeAccountId) {
        return "Please select a fee expense account";
      }
    }

    if (
      (investmentAction === "dividend" || investmentAction === "capGain") &&
      !investmentIncomeAccountId
    ) {
      return "Please select an income account";
    }

    if (investmentAction === "fee" && !investmentFeeAccountId) {
      return "Please select an expense account for fees";
    }

    return null;
  };

  const buildSplits = (): {
    splits: SplitInput[];
    investmentSplits: InvestmentSplitInput[];
  } => {
    const isSplitAction = investmentAction === "split";
    const sharesMicros = isSplitAction ? 0 : parseMicrosInput(investmentShares);
    const priceMicros = isSplitAction ? 0 : parseMicrosInput(investmentPrice);
    const feesCents = isSplitAction ? 0 : parseCentsInput(investmentFee);
    const grossAmount = getInvestmentGrossAmountCents(sharesMicros, priceMicros);
    const splitNumeratorInput = investmentSplitNumerator.trim();
    const splitDenominatorInput = investmentSplitDenominator.trim();
    const splitNumerator = isSplitAction ? Number(splitNumeratorInput) : undefined;
    const splitDenominator = isSplitAction ? Number(splitDenominatorInput) : undefined;

    let finalSplits: SplitInput[];
    switch (investmentAction) {
      case "buy":
        finalSplits = buildBuySplits({
          securityAccountId: investmentAccountId ?? 0,
          cashAccountId: investmentCashAccountId!,
          feeAccountId: feesCents > 0 ? investmentFeeAccountId ?? undefined : undefined,
          sharesMicros,
          priceMicros,
          feesCents,
        });
        break;
      case "sell":
        finalSplits = buildSellSplits({
          securityAccountId: investmentAccountId ?? 0,
          cashAccountId: investmentCashAccountId!,
          feeAccountId: feesCents > 0 ? investmentFeeAccountId ?? undefined : undefined,
          sharesMicros,
          priceMicros,
          feesCents,
        });
        break;
      case "dividend": {
        const dividendAmountCents = parseCentsInput(investmentDividendAmount);
        finalSplits = buildDividendSplits({
          cashAccountId: investmentCashAccountId!,
          incomeAccountId: investmentIncomeAccountId ?? 0,
          amountCents: dividendAmountCents,
        });
        break;
      }
      case "capGain": {
        const capGainAmountCents = parseCentsInput(investmentCapGainAmount);
        finalSplits = buildCapGainSplits({
          cashAccountId: investmentCashAccountId!,
          incomeAccountId: investmentIncomeAccountId ?? 0,
          amountCents: capGainAmountCents,
        });
        break;
      }
      case "fee": {
        const feeAmount = feesCents > 0 ? feesCents : grossAmount;
        finalSplits = [
          {
            accountId: investmentFeeAccountId ?? 0,
            amount: feeAmount,
          },
          {
            accountId: investmentCashAccountId!,
            amount: -feeAmount,
          },
          ];
        break;
      }
      case "split":
        finalSplits = [
          {
            accountId: investmentAccountId ?? 0,
            amount: 0,
          },
          {
            accountId: investmentCashAccountId!,
            amount: 0,
          },
        ];
        break;
      default:
        finalSplits = [];
    }

    const investmentSplits: InvestmentSplitInput[] = [
      {
        securityId: selectedSecurityId!,
        action: investmentAction,
        sharesMicros: investmentAction === "dividend" || investmentAction === "capGain" ? 0 : sharesMicros,
        priceMicros: investmentAction === "dividend" || investmentAction === "capGain" ? 0 : priceMicros,
        feesCents,
        splitNumerator,
        splitDenominator,
      },
    ];

    return { splits: finalSplits, investmentSplits };
  };

  const reset = () => {
    setSelectedSecurityId(null);
    setInvestmentShares("");
    setInvestmentPrice("");
    setInvestmentFee("");
    setInvestmentDividendAmount("");
    setInvestmentCapGainAmount("");
    setInvestmentSplitNumerator("");
    setInvestmentSplitDenominator("");
  };

  return {
    securities,
    investmentAccountId,
    setInvestmentAccountId,
    investmentIncomeAccountId,
    setInvestmentIncomeAccountId,
    investmentFeeAccountId,
    setInvestmentFeeAccountId,
    selectedSecurityId,
    setSelectedSecurityId,
    selectSecurity,
    selectedSecurity,
    investmentAction,
    setInvestmentAction,
    investmentShares,
    setInvestmentShares,
    investmentPrice,
    setInvestmentPrice,
    investmentFee,
    setInvestmentFee,
    investmentDividendAmount,
    setInvestmentDividendAmount,
    investmentCapGainAmount,
    setInvestmentCapGainAmount,
    investmentSplitNumerator,
    setInvestmentSplitNumerator,
    investmentSplitDenominator,
    setInvestmentSplitDenominator,
    pendingNewAccountId,
    setPendingNewAccountId,

    investmentCashAccountId,
    investmentTotal,

    validate,
    buildSplits,
    reset,
  };
}
