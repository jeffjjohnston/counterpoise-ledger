"use client";

import { useEffect, useMemo, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { useBookChanges } from "@/components/BookChangesProvider";
import { apiGet } from "@/lib/api-client";
import { formatPriceMicrosInput, parseStrictCurrency } from "@/lib/wasm-client";
import { evaluateExpression } from "@/lib/wasm-client";
import {
  buildBuySplits,
  buildCapGainSplits,
  buildDividendSplits,
  buildReinvestSplits,
  buildSellSplits,
  getInvestmentGrossAmountCents,
  reinvestPriceMicros,
} from "@/lib/wasm-client";
import type {
  AccountWithBalance,
  InvestmentSplitInput,
  SplitInput,
  TransactionWithSplits,
} from "@/types";
import {
  formatMicrosInput,
  type InvestmentFields,
  type InvestmentFormAction,
} from "./transaction-form-fields";

interface Security {
  id: number;
  name: string;
  symbol: string;
  securityType: string;
  fixedPriceMicros?: number | null;
}

/** The Action of the form. "reinvest" saves a dividend and a buy split. */
export type InvestmentAction = InvestmentFormAction;

export interface InvestmentEntry {
  // state + setters the section renders from
  securities: Security[];
  /** The securities with shares in the investment account, for the Security list. */
  heldSecurityIds: ReadonlySet<number>;
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
  /**
   * `remainderCents` is the cash rest of a Dividend Reinvest:
   * dividend - shares x price - fee. It is 0 for the other actions.
   */
  investmentTotal: { grossAmount: number; totalCents: number; remainderCents: number };

  // behaviour
  validate: () => string | null; // null = valid; otherwise the message to toast
  buildSplits: () => { splits: SplitInput[]; investmentSplits: InvestmentSplitInput[] };
  reset: () => void;
  /** Fill the fields from a saved transaction. An undefined field is kept. */
  restore: (fields: InvestmentFields) => void;
}

export function useInvestmentEntry(args: {
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  editingTransaction?: TransactionWithSplits | null;
}): InvestmentEntry {
  const { accounts, selectedAccountId, editingTransaction } = args;

  const bookId = useBookId();

  const [securities, setSecurities] = useState<Security[]>([]);
  // With the account that it is for, so that a switch to another account
  // does not show the previous account's list under the new name.
  const [held, setHeld] = useState<{ accountId: number; ids: ReadonlySet<number> } | null>(
    null
  );
  const [positionsVersion, setPositionsVersion] = useState(0);
  const [investmentAccountId, setInvestmentAccountId] = useState<number | null>(null);
  const [investmentIncomeAccountId, setInvestmentIncomeAccountId] = useState<number | null>(
    null
  );
  const [investmentFeeAccountId, setInvestmentFeeAccountId] = useState<number | null>(
    null
  );
  const [selectedSecurityId, setSelectedSecurityId] = useState<number | null>(null);
  const [investmentAction, setInvestmentAction] = useState<InvestmentAction>("buy");
  const [investmentShares, setInvestmentShares] = useState("");
  const [investmentPrice, setRawInvestmentPrice] = useState("");
  // Dividend Reinvest fills the price from the dividend, the fee and the
  // shares until the user types a price. A saved or a fixed price counts as
  // typed. An emptied field goes back to the computed price.
  const [priceTyped, setPriceTyped] = useState(false);
  const setInvestmentPrice = (value: string) => {
    setPriceTyped(value.trim() !== "");
    setRawInvestmentPrice(value);
  };
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
      setRawInvestmentPrice(formatPriceMicrosInput(next.fixedPriceMicros));
      setPriceTyped(true);
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
      setRawInvestmentPrice("");
      setPriceTyped(false);
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

  // A write that adds or removes shares changes what the account holds.
  useBookChanges((change) => {
    if (change.type === "reset" || change.tables.includes("investment_splits")) {
      setPositionsVersion((version) => version + 1);
    }
  });

  useEffect(() => {
    if (!investmentAccountId) return;
    let current = true;
    const loadHeld = async () => {
      try {
        const positions = await apiGet<unknown>(
          `/api/b/${bookId}/investments/positions?accountId=${investmentAccountId}`
        );
        const ids = Array.isArray(positions)
          ? positions
              .map((position: { securityId?: unknown }) => position?.securityId)
              .filter((id): id is number => typeof id === "number")
          : [];
        if (current) setHeld({ accountId: investmentAccountId, ids: new Set(ids) });
      } catch {
        // The held list only orders the Security list. Without it, the list
        // shows all securities by type, as before.
        if (current) setHeld(null);
      }
    };
    void loadHeld();
    return () => {
      current = false;
    };
  }, [bookId, investmentAccountId, positionsVersion]);
  const heldSecurityIds = useMemo<ReadonlySet<number>>(
    () => (held && held.accountId === investmentAccountId ? held.ids : new Set()),
    [held, investmentAccountId]
  );

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

  // The default price of a Dividend Reinvest: (dividend - fee) / shares,
  // rounded down to micros, so the cash rest is never negative.
  const computeReinvestPrice = (): number | null => {
    try {
      return reinvestPriceMicros(
        parseCentsInput(investmentDividendAmount),
        parseCentsInput(investmentFee),
        parseMicrosInput(investmentShares)
      );
    } catch {
      // An amount too large for i64 while the user types: no price yet.
      return null;
    }
  };
  const defaultReinvestPrice =
    investmentAction === "reinvest" && !priceTyped ? computeReinvestPrice() : null;
  useEffect(() => {
    if (investmentAction !== "reinvest" || priceTyped) return;
    setRawInvestmentPrice(
      defaultReinvestPrice === null ? "" : formatMicrosInput(defaultReinvestPrice)
    );
  }, [defaultReinvestPrice, investmentAction, priceTyped]);

  const investmentTotal = useMemo(() => {
    const sharesMicros = parseMicrosInput(investmentShares);
    const priceMicros = parseMicrosInput(investmentPrice);
    const feesCents = parseCentsInput(investmentFee);
    const grossAmount = getInvestmentGrossAmountCents(sharesMicros, priceMicros);
    const dividendAmountCents = parseCentsInput(investmentDividendAmount);
    const capGainAmountCents = parseCentsInput(investmentCapGainAmount);

    let totalCents = grossAmount;
    let remainderCents = 0;
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
      case "reinvest":
        totalCents = dividendAmountCents;
        remainderCents = dividendAmountCents - grossAmount - feesCents;
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

    return { grossAmount, totalCents, remainderCents };
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
      ["buy", "sell", "reinvest"].includes(investmentAction) &&
      (sharesMicros <= 0 || priceMicros <= 0)
    ) {
      return "Shares and price are required for this investment action";
    }

    if (investmentAction === "dividend" || investmentAction === "reinvest") {
      const dividendAmount = parseCentsInput(investmentDividendAmount);
      if (dividendAmount <= 0) {
        return "Dividend amount is required";
      }
    }

    if (investmentAction === "reinvest" && feesCents < 0) {
      return "The fee must not be negative";
    }

    if (
      investmentAction === "reinvest" &&
      parseCentsInput(investmentDividendAmount) - grossAmount - feesCents < 0
    ) {
      return "The shares and the fee cost more than the dividend";
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

    if (
      investmentAction === "buy" ||
      investmentAction === "sell" ||
      investmentAction === "reinvest"
    ) {
      if (feesCents > 0 && !investmentFeeAccountId) {
        return "Please select a fee expense account";
      }
    }

    if (
      (investmentAction === "dividend" ||
        investmentAction === "capGain" ||
        investmentAction === "reinvest") &&
      !investmentIncomeAccountId
    ) {
      return "Please select an income account";
    }

    if (investmentAction === "fee" && !investmentFeeAccountId) {
      return "Please select an expense account for fees";
    }

    // The builder makes the last checks (for example an amount too large for
    // i64). Its message goes to the toast, so that the save does not throw.
    if (investmentAction === "reinvest") {
      try {
        buildReinvestEntry();
      } catch (error) {
        return error instanceof Error ? error.message : "The reinvestment is not valid";
      }
    }

    return null;
  };

  /** The splits of a Dividend Reinvest. Throws on a bad input. */
  const buildReinvestEntry = () => {
    const feesCents = parseCentsInput(investmentFee);
    return buildReinvestSplits({
      securityAccountId: investmentAccountId ?? 0,
      cashAccountId: investmentCashAccountId!,
      incomeAccountId: investmentIncomeAccountId ?? 0,
      feeAccountId: feesCents > 0 ? investmentFeeAccountId ?? undefined : undefined,
      dividendCents: parseCentsInput(investmentDividendAmount),
      sharesMicros: parseMicrosInput(investmentShares),
      priceMicros: parseMicrosInput(investmentPrice),
      feesCents,
    });
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

    if (investmentAction === "reinvest") {
      const built = buildReinvestEntry();
      return {
        splits: built.splits,
        investmentSplits: built.investmentSplits.map((split) => ({
          securityId: selectedSecurityId!,
          ...split,
        })),
      };
    }

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
        action: investmentAction as InvestmentSplitInput["action"],
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
    setRawInvestmentPrice("");
    setPriceTyped(false);
    setInvestmentFee("");
    setInvestmentDividendAmount("");
    setInvestmentCapGainAmount("");
    setInvestmentSplitNumerator("");
    setInvestmentSplitDenominator("");
  };

  // Uses the bare setSelectedSecurityId, not selectSecurity: a saved
  // transaction keeps the price it was recorded at.
  const restore = (fields: InvestmentFields) => {
    setSelectedSecurityId(fields.securityId);
    setInvestmentAction(fields.action);
    setInvestmentShares(fields.shares);
    setRawInvestmentPrice(fields.price);
    setPriceTyped(true);
    setInvestmentFee(fields.fee);
    setInvestmentSplitNumerator(fields.splitNumerator);
    setInvestmentSplitDenominator(fields.splitDenominator);
    if (fields.dividendAmount !== undefined) setInvestmentDividendAmount(fields.dividendAmount);
    if (fields.capGainAmount !== undefined) setInvestmentCapGainAmount(fields.capGainAmount);
    if (fields.accountId !== undefined) setInvestmentAccountId(fields.accountId);
    if (fields.incomeAccountId !== undefined) setInvestmentIncomeAccountId(fields.incomeAccountId);
    if (fields.feeAccountId !== undefined) setInvestmentFeeAccountId(fields.feeAccountId);
  };

  return {
    securities,
    heldSecurityIds,
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
    restore,
  };
}
