"use client";

import type { ReactElement } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { SecurityAutocomplete } from "@/components/ui/SecurityAutocomplete";
import { formatCurrency, resolveAmountOnBlur } from "@/lib/formatters";
import { evaluateExpression } from "@/lib/expression";
import type { AccountWithBalance } from "@/types";
import type { InvestmentEntry } from "./useInvestmentEntry";

// Renders the investment-specific field set (Security, Action, Investment
// Account, the conditional Income/Fee accounts, and the action-specific
// shares/price/fee | dividend | capGain | split row) shared by TransactionForm's
// compact and desktop layouts. The two layouts differ in:
//   - the Investment Account field's label ("Inv. Account" vs "Investment
//     Account", driven by `compact`)
//   - every Input/Select's `size` ("compact" vs the default)
//   - placeholder copy and Select option labels (terser in compact)
//   - grid structure: compact packs Security/Action/Account into the
//     caller's shared Date+Payee row (hence the `col-span-full` rows below,
//     which make the trailing fields wrap onto their own full-width lines
//     within that same grid rather than starting a new container); desktop
//     uses its own self-contained grids
//   - the Total display: compact shows a plain inline total (and none at
//     all for "split"); desktop always shows a bordered Total box, with a
//     description that varies by action (including for "split")
//   - the "Add Transaction" submit button: present inline only in compact,
//     since desktop shares a single Save/Cancel bar below all three modes
export function InvestmentEntrySection(props: {
  investment: InvestmentEntry;
  accounts: AccountWithBalance[];
  compact: boolean;
}): ReactElement {
  const { investment, accounts, compact } = props;

  const formatMicrosInput = (value: number) => {
    const formatted = (value / 1_000_000).toFixed(6);
    return formatted.replace(/\.?0+$/, "");
  };

  // A fixed-price security's price is filled in from the security itself, so
  // the label says so rather than leaving a value that looks typed.
  const priceLabel =
    investment.selectedSecurity?.fixedPriceMicros != null ? "Price (fixed)" : "Price";

  const handlePriceBlur = () => {
    if (!investment.investmentPrice.trim()) return;
    const evaluated = evaluateExpression(investment.investmentPrice);
    if (evaluated !== null) {
      investment.setInvestmentPrice(formatMicrosInput(Math.round(evaluated * 1_000_000)));
    }
  };

  const investmentAccounts = accounts.filter(
    (a) => a.type === "asset" && a.subtype === "investment"
  );
  const incomeAccounts = accounts.filter((a) => a.type === "income");
  const expenseAccounts = accounts.filter((a) => a.type === "expense");

  const showIncomeAccount =
    investment.investmentAction === "dividend" || investment.investmentAction === "capGain";
  const showFeeAccount =
    investment.investmentAction === "buy" ||
    investment.investmentAction === "sell" ||
    investment.investmentAction === "fee";

  if (compact) {
    return (
      <>
        <SecurityAutocomplete
          label="Security"
          securities={investment.securities}
          value={investment.selectedSecurityId}
          onChange={(id) => investment.selectSecurity(id)}
          placeholder="Security..."
          allowClear={false}
          size="compact"
        />
        <Select
          label="Action"
          id="investmentAction"
          size="compact"
          value={investment.investmentAction}
          onChange={(e) =>
            investment.setInvestmentAction(
              e.target.value as "buy" | "sell" | "dividend" | "capGain" | "fee" | "split"
            )
          }
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
            { value: "dividend", label: "Dividend" },
            { value: "capGain", label: "Cap Gain" },
            { value: "fee", label: "Fee" },
            { value: "split", label: "Split" },
          ]}
        />
        <AccountAutocomplete
          label="Inv. Account"
          accounts={investmentAccounts}
          value={investment.investmentAccountId}
          onChange={(id) => investment.setInvestmentAccountId(id)}
          placeholder="Account..."
          showHierarchy={true}
          allowClear={false}
          size="compact"
        />
        {showIncomeAccount && (
          <AccountAutocomplete
            label="Income Account"
            accounts={incomeAccounts}
            value={investment.investmentIncomeAccountId}
            onChange={(id) => investment.setInvestmentIncomeAccountId(id)}
            placeholder="Income account..."
            showHierarchy={true}
            allowClear={false}
            size="compact"
            className="col-span-full"
          />
        )}
        {showFeeAccount && (
          <AccountAutocomplete
            label="Fee/Expense Account"
            accounts={expenseAccounts}
            value={investment.investmentFeeAccountId}
            onChange={(id) => investment.setInvestmentFeeAccountId(id)}
            placeholder="Expense account..."
            showHierarchy={true}
            allowClear={false}
            size="compact"
            className="col-span-full"
          />
        )}
        {investment.investmentAction === "split" ? (
          <div className="col-span-full grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <Input type="number" label="Split Numerator" id="investmentSplitNumerator" size="compact"
              value={investment.investmentSplitNumerator} onChange={(e) => investment.setInvestmentSplitNumerator(e.target.value)}
              placeholder="2" min="1" step="any" selectOnFocus />
            <Input type="number" label="Split Denominator" id="investmentSplitDenominator" size="compact"
              value={investment.investmentSplitDenominator} onChange={(e) => investment.setInvestmentSplitDenominator(e.target.value)}
              placeholder="1" min="1" step="any" selectOnFocus />
            <Button type="submit" size="sm" aria-label="Add Transaction" className="mb-px">Add</Button>
          </div>
        ) : investment.investmentAction === "dividend" ? (
          <div className="col-span-full grid grid-cols-[1fr_auto_auto] gap-2 items-end">
            <Input type="text" label="Dividend Amount" id="investmentDividendAmount" size="compact"
              value={investment.investmentDividendAmount} onChange={(e) => investment.setInvestmentDividendAmount(e.target.value)}
              onBlur={() => investment.setInvestmentDividendAmount(resolveAmountOnBlur(investment.investmentDividendAmount))}
              placeholder="0.00" selectOnFocus />
            <div className="mb-1 text-sm text-fg-secondary font-medium whitespace-nowrap" data-testid="investment-total">
              {formatCurrency(investment.investmentTotal.totalCents)}
            </div>
            <Button type="submit" size="sm" aria-label="Add Transaction" className="mb-px">Add</Button>
          </div>
        ) : investment.investmentAction === "capGain" ? (
          <div className="col-span-full grid grid-cols-[1fr_auto_auto] gap-2 items-end">
            <Input type="text" label="Capital Gain Amount" id="investmentCapGainAmount" size="compact"
              value={investment.investmentCapGainAmount} onChange={(e) => investment.setInvestmentCapGainAmount(e.target.value)}
              onBlur={() => investment.setInvestmentCapGainAmount(resolveAmountOnBlur(investment.investmentCapGainAmount))}
              placeholder="0.00" selectOnFocus />
            <div className="mb-1 text-sm text-fg-secondary font-medium whitespace-nowrap" data-testid="investment-total">
              {formatCurrency(investment.investmentTotal.totalCents)}
            </div>
            <Button type="submit" size="sm" aria-label="Add Transaction" className="mb-px">Add</Button>
          </div>
        ) : (
          <div className="col-span-full grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 items-end">
            <Input type="text" label="Shares" id="investmentShares" size="compact"
              value={investment.investmentShares} onChange={(e) => investment.setInvestmentShares(e.target.value)}
              placeholder="0.000000" selectOnFocus />
            <Input type="text" label={priceLabel} id="investmentPrice" size="compact"
              value={investment.investmentPrice} onChange={(e) => investment.setInvestmentPrice(e.target.value)}
              onBlur={handlePriceBlur}
              placeholder="0.000000" selectOnFocus />
            <Input type="text" label="Fee" id="investmentFee" size="compact"
              value={investment.investmentFee} onChange={(e) => investment.setInvestmentFee(e.target.value)}
              onBlur={() => investment.setInvestmentFee(resolveAmountOnBlur(investment.investmentFee))}
              placeholder="0.00" selectOnFocus />
            <div className="mb-1 text-sm text-fg-secondary font-medium whitespace-nowrap" data-testid="investment-total">
              {formatCurrency(investment.investmentTotal.totalCents)}
            </div>
            <Button type="submit" size="sm" aria-label="Add Transaction" className="mb-px">Add</Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <SecurityAutocomplete
          label="Security"
          securities={investment.securities}
          value={investment.selectedSecurityId}
          onChange={(id) => investment.selectSecurity(id)}
          placeholder="Search by name or symbol..."
          allowClear={false}
        />
        <Select
          label="Action"
          id="investmentAction"
          value={investment.investmentAction}
          onChange={(e) =>
            investment.setInvestmentAction(
              e.target.value as
                | "buy"
                | "sell"
                | "dividend"
                | "capGain"
                | "fee"
                | "split"
            )
          }
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
            { value: "dividend", label: "Dividend" },
            { value: "capGain", label: "Capital Gain" },
            { value: "fee", label: "Fee" },
            { value: "split", label: "Stock Split" },
          ]}
        />
        <AccountAutocomplete
          label="Investment Account"
          accounts={investmentAccounts}
          value={investment.investmentAccountId}
          onChange={(id) => investment.setInvestmentAccountId(id)}
          placeholder="Search for investment account..."
          showHierarchy={true}
          allowClear={false}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {showIncomeAccount && (
          <AccountAutocomplete
            label="Income Account"
            accounts={incomeAccounts}
            value={investment.investmentIncomeAccountId}
            onChange={(id) => investment.setInvestmentIncomeAccountId(id)}
            placeholder="Search for income account..."
            showHierarchy={true}
            allowClear={false}
          />
        )}
        {showFeeAccount && (
          <AccountAutocomplete
            label="Fee/Expense Account"
            accounts={expenseAccounts}
            value={investment.investmentFeeAccountId}
            onChange={(id) => investment.setInvestmentFeeAccountId(id)}
            placeholder="Search for expense account..."
            showHierarchy={true}
            allowClear={false}
          />
        )}
      </div>

      {investment.investmentAction === "split" ? (
        <div className="grid grid-cols-2 gap-4">
          <Input
            type="number"
            label="Split Numerator"
            id="investmentSplitNumerator"
            value={investment.investmentSplitNumerator}
            onChange={(e) => investment.setInvestmentSplitNumerator(e.target.value)}
            placeholder="2"
            min="1"
            step="any"
            selectOnFocus
          />
          <Input
            type="number"
            label="Split Denominator"
            id="investmentSplitDenominator"
            value={investment.investmentSplitDenominator}
            onChange={(e) => investment.setInvestmentSplitDenominator(e.target.value)}
            placeholder="1"
            min="1"
            step="any"
            selectOnFocus
          />
        </div>
      ) : investment.investmentAction === "dividend" ? (
        <div className="grid grid-cols-1 gap-4">
          <Input
            type="text"
            label="Dividend Amount"
            id="investmentDividendAmount"
            value={investment.investmentDividendAmount}
            onChange={(e) => investment.setInvestmentDividendAmount(e.target.value)}
            onBlur={() => investment.setInvestmentDividendAmount(resolveAmountOnBlur(investment.investmentDividendAmount))}
            placeholder="0.00"
            selectOnFocus
          />
        </div>
      ) : investment.investmentAction === "capGain" ? (
        <div className="grid grid-cols-1 gap-4">
          <Input
            type="text"
            label="Capital Gain Amount"
            id="investmentCapGainAmount"
            value={investment.investmentCapGainAmount}
            onChange={(e) => investment.setInvestmentCapGainAmount(e.target.value)}
            onBlur={() => investment.setInvestmentCapGainAmount(resolveAmountOnBlur(investment.investmentCapGainAmount))}
            placeholder="0.00"
            selectOnFocus
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Input
            type="text"
            label="Shares"
            id="investmentShares"
            value={investment.investmentShares}
            onChange={(e) => investment.setInvestmentShares(e.target.value)}
            placeholder="0.000000"
            selectOnFocus
          />
          <Input
            type="text"
            label={priceLabel}
            id="investmentPrice"
            value={investment.investmentPrice}
            onChange={(e) => investment.setInvestmentPrice(e.target.value)}
            onBlur={handlePriceBlur}
            placeholder="0.000000"
            selectOnFocus
          />
          <Input
            type="text"
            label="Fee"
            id="investmentFee"
            value={investment.investmentFee}
            onChange={(e) => investment.setInvestmentFee(e.target.value)}
            onBlur={() => investment.setInvestmentFee(resolveAmountOnBlur(investment.investmentFee))}
            placeholder="0.00"
            selectOnFocus
          />
        </div>
      )}

      <div className="rounded-md border border-border bg-surface-secondary px-3 py-2 text-sm text-fg-secondary">
        <div className="flex items-center justify-between">
          <span>Total</span>
          <output
            id="investmentTotal"
            aria-live="polite"
            data-testid="investment-total"
            className="font-medium"
          >
            {formatCurrency(investment.investmentTotal.totalCents)}
          </output>
        </div>
        {investment.investmentAction === "split" ? (
          <p className="text-xs text-fg-tertiary">
            Stock splits adjust share counts without changing cash balances.
          </p>
        ) : investment.investmentAction === "dividend" ? (
          <p className="text-xs text-fg-tertiary">
            Cash dividend paid to investment account
          </p>
        ) : investment.investmentAction === "capGain" ? (
          <p className="text-xs text-fg-tertiary">
            Capital gain distribution paid to investment account
          </p>
        ) : (
          <p className="text-xs text-fg-tertiary">
            Based on shares × price
            {investment.investmentAction === "buy" || investment.investmentAction === "sell"
              ? ` ${investment.investmentAction === "buy" ? "+" : "-"} fees`
              : ""}{" "}
            {investment.investmentAction === "fee" && investment.investmentTotal.grossAmount > 0
              ? "or fee amount"
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}
