"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { buildAccountHierarchyName, buildCategoryLabelMap, getEffectiveDate } from "@/lib/accounting";
import { formatCurrency, formatDate, toDateString } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { TransactionWithSplits, DisplayTransaction, AccountWithBalance } from "@/types";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { CategoryIcon } from "@/components/ui/CategoryIcon";
import { NoteIndicator } from "./NoteIndicator";

const TRANSACTION_TABLE_COLUMN_WIDTHS = {
  date: "w-[7rem]",
  payee: "w-[32%]",
  accounts: "w-[24%]",
  amount: "w-[8rem]",
  balance: "w-[8rem]",
} as const;

// An investment account's register answers different questions than a bank
// account's: which security, how many shares, at what price. Payee is near-always
// empty on a trade, so its width is given back to Activity and to two numeric
// columns that can be scanned vertically.
// Activity is the only flexible column here, and `table-fixed` satisfies every
// fixed width before it gets anything. Keep the fixed columns lean enough that
// Activity still has room in the narrowest desktop register (~736px: the 1024px
// lg breakpoint, less the sidebar and padding). Left wider, Activity collapses to
// zero and its text paints over Shares.
const INVESTMENT_TABLE_COLUMN_WIDTHS = {
  date: "w-[7rem]",
  activity: "w-[30%]",
  shares: "w-[7rem]",
  price: "w-[6rem]",
  amount: "w-[7.5rem]",
  balance: "w-[7rem]",
} as const;

// Widest tag is CAPGAIN; every tag reserves the same box so the symbols beside
// them form a straight column.
const ACTIVITY_TAG_WIDTH = "w-[3.5rem]";

// Geometry for the row actions menu. The estimate constants mirror the menu's
// Tailwind classes (py-1 container, px-3 py-1.5 text-sm items, my-1 separator)
// closely enough to keep the menu on-screen; pixel-perfection isn't required.
const ROW_MENU_MARGIN = 8;
const ROW_MENU_GAP = 4;
const ROW_MENU_ITEM_HEIGHT = 32;
const ROW_MENU_VERTICAL_PADDING = 8;
const ROW_MENU_SEPARATOR_HEIGHT = 9;

function estimateRowMenuHeight(itemCount: number, hasSeparator: boolean): number {
  return (
    ROW_MENU_VERTICAL_PADDING +
    itemCount * ROW_MENU_ITEM_HEIGHT +
    (hasSeparator ? ROW_MENU_SEPARATOR_HEIGHT : 0)
  );
}

/**
 * Clamp the row actions menu so it stays fully within the viewport on both axes.
 * Anchored below and right-aligned to the trigger, then pulled in from any edge.
 * Exported for unit testing (jsdom can't measure real layout geometry).
 */
export function computeRowMenuPosition({
  triggerRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
}: {
  triggerRect: { right: number; bottom: number };
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const x = Math.max(
    ROW_MENU_MARGIN,
    Math.min(
      triggerRect.right - menuWidth,
      viewportWidth - menuWidth - ROW_MENU_MARGIN
    )
  );
  const y = Math.max(
    ROW_MENU_MARGIN,
    Math.min(
      triggerRect.bottom + ROW_MENU_GAP,
      viewportHeight - menuHeight - ROW_MENU_MARGIN
    )
  );
  return { x, y };
}

interface TransactionListProps {
  transactions: DisplayTransaction[];
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  balanceAccountId?: number | null;
  startingBalance?: number;
  onEdit: (transaction: TransactionWithSplits) => void;
  onProjectedClick?: (recurringRuleId: number) => void;
  onPlaidPendingClick?: () => void;
  onToggleReconciled?: (transactionId: number, isReconciled: boolean) => void;
  onMoveToNextBusinessDay?: (transactionId: number) => void;
  newTransactionId?: number | null;
  onNewTransactionAnimated?: () => void;
  highlightTransactionId?: number | null;
  onHighlightAnimated?: () => void;
  onNavigateToAccount?: (accountId: number, transactionId: number) => void;
  isLoading?: boolean;
}

export function TransactionList({
  transactions,
  accounts,
  selectedAccountId,
  balanceAccountId,
  startingBalance = 0,
  onEdit,
  onProjectedClick,
  onPlaidPendingClick,
  onToggleReconciled,
  onMoveToNextBusinessDay,
  newTransactionId,
  onNewTransactionAnimated,
  highlightTransactionId,
  onHighlightAnimated,
  onNavigateToAccount,
  isLoading = false,
}: TransactionListProps) {
  const isMobile = useIsMobile();
  const highlightRef = useRef<HTMLTableRowElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    transaction: DisplayTransaction;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Whether any per-row action is wired up. Drives the visible overflow (⋯) menu so
  // reconcile / go-to are reachable without right-click (and at all on touch).
  const hasRowActions = !!(
    onNavigateToAccount ||
    onToggleReconciled ||
    onMoveToNextBusinessDay
  );
  // The page sets balanceAccountId only for an investment account's cash
  // sub-account, so it doubles as "this is an investment register" and selects
  // the Activity / Shares / Price column set below.
  const isInvestmentRegister = balanceAccountId != null;

  const getGoToAccounts = useCallback(
    (transaction: DisplayTransaction) => {
      const targetAccountId = balanceAccountId ?? selectedAccountId;
      const goToAccounts = new Map<
        number,
        { accountId: number; accountName: string }
      >();

      const addSplitAccount = (
        split: DisplayTransaction["splits"][number]
      ) => {
        if (split.accountId === targetAccountId || goToAccounts.has(split.accountId)) {
          return;
        }
        goToAccounts.set(split.accountId, {
          accountId: split.accountId,
          accountName: buildAccountHierarchyName(split.account, accounts),
        });
      };

      if (targetAccountId) {
        const targetSplit = transaction.splits.find(
          (split) => split.accountId === targetAccountId && split.amount !== 0
        );

        if (targetSplit) {
          for (const split of transaction.splits) {
            if (split.amount * targetSplit.amount < 0) {
              addSplitAccount(split);
            }
          }
        }
      }

      if (goToAccounts.size === 0) {
        for (const split of transaction.splits) {
          addSplitAccount(split);
        }
      }

      return Array.from(goToAccounts.values());
    },
    [accounts, balanceAccountId, selectedAccountId]
  );

  // Whether the row menu would show anything for this transaction — mirrors the
  // show* gating in renderRowMenu. Both menu entry points check this before
  // setting contextMenu (opening a menu that renders null would leave invisible
  // open-menu state behind: document listeners attached, and the click-outside
  // handler can't clear it because the menu ref is never populated), and the
  // ⋯ trigger is hidden for such rows so aria-haspopup buttons always open a menu.
  const hasRowMenuActions = useCallback(
    (transaction: DisplayTransaction) =>
      (!!onNavigateToAccount && getGoToAccounts(transaction).length > 0) ||
      !!onToggleReconciled ||
      (!!onMoveToNextBusinessDay && !transaction.isReconciled),
    [onNavigateToAccount, onToggleReconciled, onMoveToNextBusinessDay, getGoToAccounts]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, transaction: DisplayTransaction) => {
      e.preventDefault();
      if (transaction.isProjected || transaction.isPlaidPending || !hasRowMenuActions(transaction)) return;
      window.getSelection()?.removeAllRanges();
      setContextMenu({ x: e.clientX, y: e.clientY, transaction });
    },
    [hasRowMenuActions]
  );

  const handleRowMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return;
    e.preventDefault();
  }, []);

  // Open the same menu the right-click context menu uses, but anchored under a
  // visible trigger (the ⋯ button). Clamped on both axes to stay within the
  // viewport — the menu's height varies with the number of go-to actions, so we
  // estimate it to decide how far up to pull near the bottom edge.
  const openRowMenu = useCallback(
    (e: React.MouseEvent, transaction: DisplayTransaction) => {
      e.preventDefault();
      e.stopPropagation();
      if (transaction.isProjected || transaction.isPlaidPending || !hasRowMenuActions(transaction)) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const goToCount = onNavigateToAccount
        ? getGoToAccounts(transaction).length
        : 0;
      const reconcileCount = onToggleReconciled ? 1 : 0;
      const moveDateCount =
        onMoveToNextBusinessDay && !transaction.isReconciled ? 1 : 0;
      const menuHeight = estimateRowMenuHeight(
        goToCount + reconcileCount + moveDateCount,
        goToCount > 0 && reconcileCount + moveDateCount > 0
      );
      const { x, y } = computeRowMenuPosition({
        triggerRect: rect,
        menuWidth: 200,
        menuHeight,
        viewportWidth:
          typeof window !== "undefined" ? window.innerWidth : 1024,
        viewportHeight:
          typeof window !== "undefined" ? window.innerHeight : 768,
      });
      window.getSelection()?.removeAllRanges();
      setContextMenu({ x, y, transaction });
    },
    [onNavigateToAccount, onToggleReconciled, onMoveToNextBusinessDay, getGoToAccounts, hasRowMenuActions]
  );

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (highlightTransactionId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightTransactionId]);

  const renderCheckNumberPill = (checkNumber: string) => (
    <span className="inline-flex flex-shrink-0 items-center rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-fg-warning">
      CHK #{checkNumber}
    </span>
  );

  const renderUpcomingPill = () => (
    <span className="inline-flex items-center rounded-full bg-future px-2 py-0.5 text-xs font-medium text-fg-accent">
      Recurring
    </span>
  );

  const renderScheduledPill = () => (
    <span className="inline-flex items-center rounded-full bg-future px-2 py-0.5 text-xs font-medium text-fg-accent">
      Scheduled
    </span>
  );

  // Teal to match Plaid's identity and stay distinct from the blue
  // Recurring/Scheduled pills
  const renderPlaidPill = () => (
    <span className="inline-flex flex-shrink-0 items-center rounded-full bg-teal-500/15 px-2 py-0.5 text-xs font-medium text-teal-700 dark:text-teal-400">
      Plaid
    </span>
  );

  const getDisplayAmount = (transaction: TransactionWithSplits) => {
    const targetAccountId = balanceAccountId ?? selectedAccountId;
    if (targetAccountId) {
      const split = transaction.splits.find(
        (s) => s.accountId === targetAccountId
      );
      return split?.amount || 0;
    }
    // For "all accounts" view, show the largest absolute amount
    const amounts = transaction.splits.map((s) => Math.abs(s.amount));
    return Math.max(...amounts);
  };

  type TransactionCategory = "simple" | "transfer" | "multi_split" | "investment";

  const categorizeTransaction = (transaction: TransactionWithSplits): TransactionCategory => {
    // Investment transactions already handled
    if (transaction.investmentSplits.length > 0) {
      return "investment";
    }

    // 2-split transactions
    if (transaction.splits.length === 2) {
      const [split1, split2] = transaction.splits;
      const type1 = split1.account.type;
      const type2 = split2.account.type;

      // Both balance sheet accounts (asset/liability) = Transfer
      const isBalanceSheet1 = type1 === "asset" || type1 === "liability";
      const isBalanceSheet2 = type2 === "asset" || type2 === "liability";

      if (isBalanceSheet1 && isBalanceSheet2) {
        return "transfer";
      }

      // One income/expense + one asset/liability = Simple
      return "simple";
    }

    // 3+ splits = Multi-split
    return "multi_split";
  };

  // One pass over the accounts rather than a tree walk per rendered row.
  const categoryLabels = useMemo(
    () => buildCategoryLabelMap(accounts),
    [accounts]
  );

  // An account with no entry — any asset, liability, or equity account — keeps
  // its existing display. That is what scopes this to categories without a
  // branch: a lookup miss is the fallback.
  const renderAccountLabel = (account: TransactionWithSplits["splits"][number]["account"]) => {
    const label = categoryLabels.get(account.id);

    if (!label) {
      return <span>{buildAccountHierarchyName(account, accounts)}</span>;
    }

    return (
      <span title={label.title}>
        <CategoryIcon icon={label.icon} />
        {label.text}
      </span>
    );
  };

  const renderSimpleTransaction = (transaction: TransactionWithSplits) => {
    const categorySplit = transaction.splits.find(
      (s) => s.account.type === "income" || s.account.type === "expense"
    );
    const assetLibSplit = transaction.splits.find(
      (s) => s.account.type === "asset" || s.account.type === "liability"
    );

    if (!categorySplit || !assetLibSplit) {
      return renderMultiSplitTransaction(transaction);
    }

    const assetLibName = buildAccountHierarchyName(assetLibSplit.account, accounts);

    // Keep account/category names neutral and the arrow a quiet connector — the
    // colored, signed amount carries direction. Avoids the ledger turning into a
    // wall of red/green (finding #10).
    return (
      <div className="flex items-center gap-1.5">
        <span>{assetLibName}</span>
        <span className="text-fg-tertiary">→</span>
        {renderAccountLabel(categorySplit.account)}
      </div>
    );
  };

  const renderTransferTransaction = (transaction: TransactionWithSplits) => {
    const [split1, split2] = transaction.splits;

    // Determine direction: from account that decreased to account that increased
    const [fromSplit, toSplit] =
      split1.amount < 0 ? [split1, split2] : [split2, split1];

    const fromName = buildAccountHierarchyName(fromSplit.account, accounts);
    const toName = buildAccountHierarchyName(toSplit.account, accounts);

    return (
      <div className="flex items-center gap-2">
        <span>{fromName}</span>
        <span className="text-fg-tertiary">→</span>
        <span>{toName}</span>
      </div>
    );
  };

  const renderMultiSplitTransaction = (transaction: TransactionWithSplits) => {
    const sortedSplits = [...transaction.splits].sort(
      (a, b) => Math.abs(b.amount) - Math.abs(a.amount)
    );

    const maxDisplay = 3;
    const displaySplits = sortedSplits.slice(0, maxDisplay);
    const remainingCount = sortedSplits.length - maxDisplay;

    return (
      <ul className="space-y-0.5">
        {displaySplits.map((split) => {
          const isPositive = split.amount > 0;

          return (
            <li key={split.id} className="flex items-center gap-1.5">
              <span className={cn(
                "text-xs font-medium w-3 text-right flex-shrink-0",
                isPositive ? "text-fg-success" : "text-fg-danger"
              )}>
                {isPositive ? "+" : "\u2212"}
              </span>
              {renderAccountLabel(split.account)}
            </li>
          );
        })}
        {remainingCount > 0 && (
          <li className="flex items-center gap-1.5 text-sm text-fg-tertiary">
            <span className="w-3 flex-shrink-0" aria-hidden="true" />
            + {remainingCount} more {remainingCount === 1 ? "account" : "accounts"}
          </li>
        )}
      </ul>
    );
  };

  const renderAccountsForAllView = (transaction: TransactionWithSplits): React.ReactNode => {
    const category = categorizeTransaction(transaction);

    switch (category) {
      case "simple":
        return renderSimpleTransaction(transaction);
      case "transfer":
        return renderTransferTransaction(transaction);
      case "multi_split":
        return renderMultiSplitTransaction(transaction);
      case "investment":
        return renderInvestmentAccounts(transaction);
    }
  };

  const formatShares = (sharesMicros: number) =>
    (sharesMicros / 1_000_000).toLocaleString("en-US", {
      maximumFractionDigits: 6,
    });

  const formatSharesLabel = (sharesMicros: number) => {
    const text = formatShares(sharesMicros);
    return `${text} ${sharesMicros === 1_000_000 ? "share" : "shares"}`;
  };

  const formatSplitRatio = (split: TransactionWithSplits["investmentSplits"][number]) => {
    const numerator = split.splitNumerator ?? 0;
    const denominator = split.splitDenominator ?? 0;
    if (numerator <= 0 || denominator <= 0) return null;
    return `${numerator}-for-${denominator}`;
  };

  // A price is stored in micros; formatCurrency takes cents.
  const formatPrice = (priceMicros: number) =>
    formatCurrency(Math.round(priceMicros / 10_000));

  type ActivityTone = "positive" | "negative" | "neutral";

  type ActivityRow = {
    id: number;
    tag: string;
    subject: string;
    tone: ActivityTone;
    /** null renders an em-dash — the action has no meaningful quantity. */
    sharesText: string | null;
    priceText: string | null;
    hasUnknownSymbol: boolean;
  };

  /**
   * Decompose a transaction's investment splits into per-action rows for the
   * investment register, keeping symbol, quantity, and price as separate fields
   * so each can occupy its own aligned column.
   */
  const buildActivityRows = (transaction: TransactionWithSplits): ActivityRow[] =>
    transaction.investmentSplits
      .map((split): ActivityRow | null => {
        const symbol = split.security?.symbol ?? "???";
        const hasUnknownSymbol = !split.security?.symbol;
        const sharesText =
          split.sharesMicros > 0 ? formatShares(split.sharesMicros) : null;
        const priceText =
          split.priceMicros > 0 ? formatPrice(split.priceMicros) : null;
        const base = { id: split.id, subject: symbol, hasUnknownSymbol };

        switch (split.action) {
          // A buy or a sell swaps cash for an asset (or back). Neither is a gain
          // or a loss, so neither is tinted — see the amount cell below.
          case "buy":
            return { ...base, tag: "BUY", tone: "neutral", sharesText, priceText };
          case "sell":
            return { ...base, tag: "SELL", tone: "neutral", sharesText, priceText };
          case "dividend":
            return { ...base, tag: "DIV", tone: "positive", sharesText, priceText };
          case "capGain":
            return { ...base, tag: "CAPGAIN", tone: "positive", sharesText, priceText };
          case "split": {
            const ratio = formatSplitRatio(split);
            return {
              ...base,
              tag: "SPLIT",
              subject: ratio ? `${symbol} ${ratio}` : symbol,
              tone: "neutral",
              sharesText: null,
              priceText: null,
            };
          }
          default:
            return null;
        }
      })
      .filter((row): row is ActivityRow => !!row);

  const activityToneClass = (tone: ActivityTone) =>
    tone === "positive"
      ? "text-fg-success"
      : tone === "negative"
        ? "text-fg-danger"
        : "text-fg";

  /**
   * A quiet uppercase action tag. Deliberately not a filled pill: every row in
   * this register carries one, and the filled style is reserved for exceptional
   * row states (Recurring, Scheduled, Plaid, CHK). Its width is fixed so the
   * symbols beside it line up down the column whatever the tag says.
   */
  const renderActivityTag = (tag: string, tone: ActivityTone) => (
    <span
      className={cn(
        ACTIVITY_TAG_WIDTH,
        "flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider",
        tone === "positive" ? "text-fg-success" : "text-fg-tertiary"
      )}
    >
      {tag}
    </span>
  );

  /** Stack one line per investment split so Shares and Price stay row-aligned. */
  const renderQuantityCell = (
    values: (string | null)[],
    muted: boolean
  ) => (
    <td
      className={cn(
        "px-4 py-3 text-sm text-right tabular-nums",
        muted ? "text-fg-tertiary italic" : "text-fg-secondary"
      )}
    >
      {values.length === 0 ? (
        <span className="text-fg-tertiary">—</span>
      ) : (
        <ul className="space-y-0.5">
          {values.map((value, index) => (
            <li key={index}>
              {value ?? <span className="text-fg-tertiary">—</span>}
            </li>
          ))}
        </ul>
      )}
    </td>
  );

  type ActivityLine = {
    key: string;
    /** null reserves the tag box so the subject still starts on the column. */
    tag: string | null;
    subject: string;
    tone: ActivityTone;
    isUncertain: boolean;
    /** A pending Plaid row is not a local transaction — render it quietly. */
    isMuted?: boolean;
  };

  /**
   * A register row with no investment splits is pure cash movement. Its lines
   * name the counterparty account, without the bank register's +/− glyph: the
   * tag column has to stay aligned across every row, and the signed amount
   * already carries direction.
   */
  const buildCashLines = (transaction: TransactionWithSplits): ActivityLine[] => {
    const targetAccountId = balanceAccountId ?? selectedAccountId;
    const selectedSplit = transaction.splits.find(
      (split) => split.accountId === targetAccountId
    );
    if (!selectedSplit) return [];

    const relatedSplits = transaction.splits.filter(
      (split) => split.amount * selectedSplit.amount < 0
    );
    const isTransfer = categorizeTransaction(transaction) === "transfer";

    return relatedSplits.map((split, index) => ({
      key: `split-${split.id}`,
      tag: index === 0 && isTransfer ? "XFER" : null,
      subject: buildAccountHierarchyName(split.account, accounts),
      tone: "neutral" as const,
      isUncertain: false,
    }));
  };

  const toActivityLine = (row: ActivityRow): ActivityLine => ({
    key: `inv-${row.id}`,
    tag: row.tag,
    subject: row.subject,
    tone: row.tone,
    isUncertain: row.hasUnknownSymbol,
  });

  /**
   * Render the activity lines, hanging a trailing note off the LAST one. The
   * note has to live inside a line's <li>: as a sibling of the <ul> it wraps
   * onto a line of its own and indents to neither the tag nor the subject
   * column. Both subject and note truncate — the Activity column is a fixed
   * 30%, so an unbounded label would spill into Shares and Price.
   */
  const renderActivityLines = (lines: ActivityLine[], note: string | null) => (
    <ul className="space-y-0.5">
      {lines.map((line, index) => (
        <li key={line.key} className="flex items-center gap-1.5 min-w-0">
          {line.tag ? (
            renderActivityTag(line.tag, line.tone)
          ) : (
            <span className={cn(ACTIVITY_TAG_WIDTH, "flex-shrink-0")} aria-hidden="true" />
          )}
          <span
            className={cn(
              "truncate",
              line.isMuted
                ? "text-fg-tertiary italic"
                : activityToneClass(line.tone),
              line.isUncertain && "italic opacity-70"
            )}
          >
            {line.subject}
          </span>
          {index === lines.length - 1 && note && (
            // Capped at half the line so a long note cannot crush the subject,
            // and shrinkable so it ellipsizes rather than overflowing the cell.
            <span className="min-w-0 max-w-[50%] truncate text-xs text-fg-tertiary">
              · {note}
            </span>
          )}
        </li>
      ))}
    </ul>
  );

  const renderInvestmentRegisterCells = (
    transaction: DisplayTransaction,
    state: { isProjected: boolean; isPlaidPending: boolean; isFuture: boolean }
  ) => {
    const { isProjected, isPlaidPending, isFuture } = state;
    const rows = isPlaidPending ? [] : buildActivityRows(transaction);
    const muted = isProjected || isPlaidPending;
    // Investment splits describe the row when present; otherwise it is cash
    // movement and the counterparty accounts do. A pending Plaid row is neither:
    // the sync route puts the merchant in `payee` and only a generic bucket in
    // `plaidCategory`, so the merchant leads and the category trails it —
    // dropping the merchant would leave rows identified as "Food And Drink".
    const lines: ActivityLine[] = isPlaidPending
      ? [
          {
            key: "plaid-pending",
            tag: null,
            subject: transaction.payee?.name ?? "Unmatched bank transaction",
            tone: "neutral",
            isUncertain: false,
            isMuted: true,
          },
        ]
      : rows.length > 0
        ? rows.map(toActivityLine)
        : buildCashLines(transaction);
    // Payee is a trailing note here, not a column: on a trade it is almost
    // always absent, and rendering "Unassigned" filler was the single largest
    // source of noise in this view.
    const note = isPlaidPending
      ? transaction.plaidCategory ?? null
      : transaction.payee?.name ?? null;

    return (
      <>
        <td
          className={cn(
            // overflow-hidden so nothing in this cell can reach the fixed-width
            // Shares and Price columns beside it.
            "px-4 py-3 text-sm overflow-hidden",
            muted ? "text-fg-tertiary italic" : "text-fg-secondary"
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {isProjected && renderUpcomingPill()}
            {isPlaidPending && renderPlaidPill()}
            {!isProjected && !isPlaidPending && isFuture && renderScheduledPill()}
            <div className="min-w-0 flex-1">
              {lines.length > 0 ? (
                renderActivityLines(lines, note)
              ) : (
                // No split names the counterparty (a multi-split, say) — fall
                // back to the shared renderer rather than showing an empty cell.
                renderAccounts(transaction)
              )}
            </div>
            {transaction.checkNumber && renderCheckNumberPill(transaction.checkNumber)}
            {transaction.notes && <NoteIndicator notes={transaction.notes} />}
          </div>
        </td>
        {renderQuantityCell(rows.map((row) => row.sharesText), muted)}
        {renderQuantityCell(rows.map((row) => row.priceText), muted)}
      </>
    );
  };

  const renderInvestmentAccounts = (transaction: TransactionWithSplits, showAccountName = true) => {
    const rows = transaction.investmentSplits
      .map((split) => {
        const symbol = split.security?.symbol ?? null;
        const accountName = split.account
          ? buildAccountHierarchyName(split.account, accounts)
          : null;
        const hasUnknownSymbol = !symbol;

        switch (split.action) {
          case "buy":
            return {
              id: split.id,
              sign: "-",
              accountName,
              hasUnknownSymbol,
              label: `Buy ${symbol ?? "???"} (${formatSharesLabel(split.sharesMicros)})`,
            };
          case "sell":
            return {
              id: split.id,
              sign: "+",
              accountName,
              hasUnknownSymbol,
              label: `Sell ${symbol ?? "???"} (${formatSharesLabel(split.sharesMicros)})`,
            };
          case "dividend":
            return {
              id: split.id,
              sign: "+",
              accountName,
              hasUnknownSymbol,
              label: `${symbol ?? "???"} Dividend`,
            };
          case "capGain":
            return {
              id: split.id,
              sign: "+",
              accountName,
              hasUnknownSymbol,
              label: `${symbol ?? "???"} Capital Gain Distribution`,
            };
          case "split": {
            const ratio = formatSplitRatio(split);
            return {
              id: split.id,
              sign: "neutral",
              accountName,
              hasUnknownSymbol,
              label: `Split ${symbol ?? "???"}${ratio ? ` (${ratio})` : ""}`,
            };
          }
          default:
            return null;
        }
      })
      .filter(
        (
          row
        ): row is { id: number; sign: "+" | "-" | "neutral"; accountName: string | null; hasUnknownSymbol: boolean; label: string } =>
          !!row
      );

    if (rows.length === 0) {
      return renderAccountsForAllView(transaction);
    }

    return (
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-1.5">
            {showAccountName && (
              <>
                {row.accountName ? (
                  <span>{row.accountName}</span>
                ) : (
                  <span className="text-fg-tertiary italic">Unknown account</span>
                )}
                <span className={cn(
                  row.sign === "neutral"
                    ? "text-fg-tertiary"
                    : row.sign === "+"
                      ? "text-fg-success"
                      : "text-fg-danger"
                )}>→</span>
              </>
            )}
            {!showAccountName && (
              <span className={cn(
                "text-xs font-medium w-3 text-right flex-shrink-0",
                row.sign === "neutral"
                  ? "text-fg-tertiary"
                  : row.sign === "+"
                    ? "text-fg-success"
                    : "text-fg-danger"
              )}>
                {row.sign === "neutral" ? "\u2022" : row.sign === "+" ? "+" : "\u2212"}
              </span>
            )}
            <span className={cn(
              row.sign === "neutral"
                ? "text-fg-tertiary"
                : row.sign === "+"
                  ? "text-fg-success"
                  : "text-fg-danger",
              row.hasUnknownSymbol && "italic opacity-70"
            )}>
              {row.label}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  const renderAccounts = (transaction: TransactionWithSplits) => {
    const targetAccountId = balanceAccountId ?? selectedAccountId;

    // When "All Accounts" is selected, use new categorization logic
    if (!targetAccountId) {
      return renderAccountsForAllView(transaction);
    }

    const isInvestmentView =
      selectedAccountId !== null &&
      balanceAccountId != null &&
      transaction.investmentSplits.length > 0;
    if (isInvestmentView) {
      return renderInvestmentAccounts(transaction, false);
    }

    const selectedSplit = transaction.splits.find(
      (split) => split.accountId === targetAccountId
    );
    if (!selectedSplit || selectedSplit.amount === 0) {
      return renderAccountsForAllView(transaction);
    }

    const relatedSplits = transaction.splits.filter(
      (split) => split.amount * selectedSplit.amount < 0
    );

    if (relatedSplits.length === 0) {
      return renderAccountsForAllView(transaction);
    }

    const isPositive = selectedSplit.amount > 0;

    return (
      <ul className="space-y-0.5">
        {relatedSplits.map((split) => {
          return (
            <li key={split.id} className="flex items-center gap-1.5">
              <span className={cn(
                "text-xs font-medium w-3 text-right flex-shrink-0",
                isPositive ? "text-fg-success" : "text-fg-danger"
              )}>
                {isPositive ? "+" : "\u2212"}
              </span>
              {renderAccountLabel(split.account)}
            </li>
          );
        })}
      </ul>
    );
  };

  // Calculate running balance for each transaction when an account is selected
  const runningBalances = useMemo(() => {
    const targetAccountId = balanceAccountId ?? selectedAccountId;
    if (!targetAccountId) return new Map<number, number>();

    // Sort transactions by date (oldest first), then by id for same-date ordering
    const sorted = [...transactions].sort((a, b) => {
      const dateCompare = getEffectiveDate(a).localeCompare(getEffectiveDate(b));
      if (dateCompare !== 0) return dateCompare;
      return a.id - b.id;
    });

    const balances = new Map<number, number>();
    let runningTotal = startingBalance;

    for (const tx of sorted) {
      // Pending Plaid rows aren't local transactions — including them would
      // make later rows' balances disagree with the account balance
      if (tx.isPlaidPending) continue;
      const split = tx.splits.find((s) => s.accountId === targetAccountId);
      if (split) {
        runningTotal += split.amount;
      }
      balances.set(tx.id, runningTotal);
    }

    return balances;
  }, [transactions, selectedAccountId, balanceAccountId, startingBalance]);
  const displayTransactions = useMemo(() => {
    const sorted = [...transactions];
    sorted.sort((a, b) => {
      const dateCmp = getEffectiveDate(b).localeCompare(getEffectiveDate(a));
      if (dateCmp !== 0) return dateCmp;
      const aProj = a.isProjected ? 1 : 0;
      const bProj = b.isProjected ? 1 : 0;
      if (aProj !== bProj) return aProj - bProj;
      return b.id - a.id;
    });
    return sorted;
  }, [transactions]);

  if (isLoading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full table-fixed">
          <colgroup>
            {isInvestmentRegister ? (
              <>
                <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.date} />
                <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.activity} />
                <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.shares} />
                <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.price} />
                <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.amount} />
                {selectedAccountId && <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.balance} />}
              </>
            ) : (
              <>
                <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.date} />
                <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.payee} />
                <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.accounts} />
                <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.amount} />
                {selectedAccountId && <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.balance} />}
              </>
            )}
          </colgroup>
          <thead>
            <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider">
              <th className="px-4 py-3 whitespace-nowrap">Date</th>
              {isInvestmentRegister ? (
                <>
                  <th className="px-4 py-3">Activity</th>
                  <th className="px-4 py-3 text-right">Shares</th>
                  <th className="px-4 py-3 text-right">Price</th>
                </>
              ) : (
                <>
                  <th className="px-4 py-3">Payee</th>
                  <th className="px-4 py-3">Accounts</th>
                </>
              )}
              <th className="px-4 py-3 text-right">Amount</th>
              {selectedAccountId && <th className="px-4 py-3 text-right">Balance</th>}
              {hasRowActions && <th className="px-2 py-3" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-secondary">
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} data-testid="transaction-skeleton-row">
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-16" />
                </td>
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-28" />
                </td>
                <td className="px-4 py-3">
                  <Skeleton className={cn("h-4", isInvestmentRegister ? "w-12 ml-auto" : "w-36")} />
                </td>
                {isInvestmentRegister && (
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-14 ml-auto" />
                  </td>
                )}
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-16 ml-auto" />
                </td>
                {selectedAccountId && (
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </td>
                )}
                {hasRowActions && (
                  <td className="px-2 py-3">
                    <Skeleton className="h-4 w-4 ml-auto" />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (transactions.length === 0) {
    return selectedAccountId ? (
      <EmptyState
        title="No transactions found"
        description="Try adjusting your filters or date range."
      />
    ) : (
      <EmptyState
        title="No transactions yet"
        description="Your transactions will appear here once you add them."
      />
    );
  }

  // Get today's date in YYYY-MM-DD format for comparison
  const today = toDateString(new Date());
  const contextMenuGoToAccounts = contextMenu
    ? getGoToAccounts(contextMenu.transaction)
    : [];

  // Visible per-row trigger for the actions menu — the affordance the right-click
  // menu lacked, and the only way to reach these actions on touch (finding #6).
  const renderOverflowButton = (transaction: DisplayTransaction) => (
    <button
      type="button"
      aria-label="Transaction actions"
      aria-haspopup="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => openRowMenu(e, transaction)}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-tertiary hover:text-fg-secondary"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    </button>
  );

  // Reconciled status indicator. When a toggle handler is wired, it's a tappable
  // button with a visible hollow state when unreconciled (so a row reads as
  // "actionable", not "empty"); otherwise it's a static dot. Projected and
  // pending Plaid rows keep an invisible placeholder to reserve the slot.
  const renderReconciledIndicator = (
    transaction: DisplayTransaction,
    isPlaceholder: boolean
  ) => {
    const testId = `transaction-amount-indicator-${transaction.id}`;
    const base = "inline-block h-2.5 w-2.5 rounded-full flex-shrink-0";
    if (isPlaceholder) {
      return (
        <span data-testid={testId} aria-hidden className={cn(base, "invisible")} />
      );
    }
    const reconciled = !!transaction.isReconciled;
    const visual = reconciled
      ? "bg-fg-success"
      : "border border-fg-tertiary bg-transparent";
    if (!onToggleReconciled) {
      return (
        <span
          data-testid={testId}
          title={reconciled ? "Reconciled" : "Not reconciled"}
          className={cn(base, visual)}
        />
      );
    }
    return (
      <button
        type="button"
        data-testid={testId}
        aria-label={
          reconciled ? "Reconciled. Mark as unreconciled" : "Mark as reconciled"
        }
        aria-pressed={reconciled}
        title={
          reconciled ? "Reconciled — click to unreconcile" : "Click to mark reconciled"
        }
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleReconciled(transaction.id, !reconciled);
        }}
        className={cn(
          base,
          "cursor-pointer transition-transform duration-150 hover:scale-125",
          visual
        )}
      />
    );
  };

  // Shared actions menu — used by both the right-click handler and the ⋯ trigger,
  // and rendered in both the mobile and desktop layouts.
  const renderRowMenu = () => {
    if (!contextMenu) return null;
    // Only render actions whose handlers are actually wired — a no-op item that
    // just closes the menu reads as broken. If nothing is actionable, render
    // nothing rather than an empty floating box.
    const showGoTo = !!onNavigateToAccount && contextMenuGoToAccounts.length > 0;
    const showReconcile = !!onToggleReconciled;
    // Only for unreconciled transactions — a reconciled date is the cleared date
    // and shouldn't be nudged. Handles scheduled ACH payments that miss their day.
    const showMoveDate =
      !!onMoveToNextBusinessDay && !contextMenu.transaction.isReconciled;
    if (!showGoTo && !showReconcile && !showMoveDate) return null;
    return (
      <div
        ref={contextMenuRef}
        role="menu"
        className="fixed z-50 min-w-[160px] rounded-md border border-border bg-surface-elevated py-1 shadow-lg"
        style={{ top: contextMenu.y, left: contextMenu.x }}
      >
        {showGoTo &&
          contextMenuGoToAccounts.map((account) => (
            <button
              key={`goto-${account.accountId}`}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-tertiary"
              onClick={() => {
                onNavigateToAccount!(account.accountId, contextMenu.transaction.id);
                setContextMenu(null);
              }}
            >
              Go to {account.accountName}
            </button>
          ))}
        {showGoTo && (showReconcile || showMoveDate) && (
          <div className="my-1 border-t border-border-secondary" />
        )}
        {showReconcile && (
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-tertiary"
            onClick={() => {
              onToggleReconciled!(
                contextMenu.transaction.id,
                !contextMenu.transaction.isReconciled
              );
              setContextMenu(null);
            }}
          >
            <span
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full flex-shrink-0",
                contextMenu.transaction.isReconciled
                  ? "border border-border bg-surface"
                  : "bg-fg-success"
              )}
            />
            {contextMenu.transaction.isReconciled ? "Unreconciled" : "Reconciled"}
          </button>
        )}
        {showMoveDate && (
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-tertiary"
            onClick={() => {
              onMoveToNextBusinessDay!(contextMenu.transaction.id);
              setContextMenu(null);
            }}
          >
            Move to next business day
          </button>
        )}
      </div>
    );
  };

  const renderTransactionRow = (transaction: DisplayTransaction) => {
    const isProjected = !!transaction.isProjected;
    const isPlaidPending = !!transaction.isPlaidPending;
    const targetAccountId = balanceAccountId ?? selectedAccountId;
    const selectedSplitAmount = targetAccountId
      ? transaction.splits.find(
          (s) => s.accountId === targetAccountId
        )?.amount ?? 0
      : 0;
    const amount = selectedAccountId
      ? selectedSplitAmount
      : getDisplayAmount(transaction);
    const isPositive = selectedAccountId ? selectedSplitAmount > 0 : true;
    const balance = runningBalances.get(transaction.id) || 0;
    const isFuture = transaction.date > today;
    const isHighlightTarget = transaction.id === highlightTransactionId;
    // A pure trade converts cash into an asset (or back) and is neither a gain
    // nor a loss, so it is not tinted. Anything that genuinely moves money in or
    // out — transfers, dividends, cap gains, fees — keeps directional colour. A
    // reinvestment (buy + dividend) counts as income and stays directional.
    const isTradeOnly =
      isInvestmentRegister &&
      transaction.investmentSplits.length > 0 &&
      transaction.investmentSplits.every(
        (split) => split.action === "buy" || split.action === "sell"
      );

    return {
      isProjected,
      isPlaidPending,
      amount,
      isPositive,
      balance,
      isFuture,
      isHighlightTarget,
      isTradeOnly,
    };
  };

  if (isMobile) {
    return (
      <>
        <div className="divide-y divide-border-secondary">
          {displayTransactions.map((transaction) => {
            const { isProjected, isPlaidPending, amount, isPositive, balance, isFuture, isHighlightTarget } =
              renderTransactionRow(transaction);

            return (
              <div
                key={transaction.id}
                ref={isHighlightTarget ? highlightRef : undefined}
                onClick={isProjected
                  ? () => transaction.recurringRuleId && onProjectedClick?.(transaction.recurringRuleId)
                  : isPlaidPending
                    ? () => onPlaidPendingClick?.()
                    : () => onEdit(transaction)}
                className={cn(
                  "px-3 py-3 cursor-pointer transition-colors",
                  isProjected
                    ? "border-l-2 border-dashed border-border-future bg-future"
                    : isPlaidPending
                      ? "border-l-2 border-dashed border-teal-500/50 bg-teal-500/5"
                      : isFuture
                        ? "border-l-2 border-border-future bg-future"
                        : "active:bg-surface-tertiary",
                  transaction.id === newTransactionId && "animate-new-row",
                  isHighlightTarget && "animate-highlight-row"
                )}
                onAnimationEnd={(e) => {
                  if (e.animationName === "row-highlight") {
                    if (transaction.id === newTransactionId) onNewTransactionAnimated?.();
                    if (isHighlightTarget) onHighlightAnimated?.();
                  }
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isProjected && renderUpcomingPill()}
                      {isPlaidPending && renderPlaidPill()}
                      {!isProjected && !isPlaidPending && isFuture && renderScheduledPill()}
                      <span className={cn(
                        "text-sm font-medium truncate",
                        isProjected ? "text-fg-tertiary italic" : "text-fg"
                      )}>
                        {transaction.payee?.name || <span className="text-fg-tertiary">Unassigned</span>}
                      </span>
                      {transaction.checkNumber && renderCheckNumberPill(transaction.checkNumber)}
                      {transaction.notes && <NoteIndicator notes={transaction.notes} />}
                    </div>
                    <div className={cn(
                      "text-xs mt-0.5",
                      isProjected ? "text-fg-tertiary italic" : "text-fg-tertiary"
                    )}>
                      {transaction.isFloating && <span title="Floating — date advances to today until reconciled">~</span>}
                      {formatDate(getEffectiveDate(transaction))}
                    </div>
                  </div>
                  <div className="flex items-start gap-1 flex-shrink-0">
                    <div className="text-right">
                      <div className={cn(
                        "flex items-center justify-end gap-1.5 text-sm font-medium tabular-nums whitespace-nowrap",
                        isProjected
                          ? selectedAccountId && isPositive
                            ? "text-fg-success-muted italic"
                            : selectedAccountId && !isPositive
                              ? "text-fg-danger-muted italic"
                              : "text-fg-tertiary italic"
                          : selectedAccountId && isPositive
                            ? "text-fg-success"
                            : selectedAccountId && !isPositive
                              ? "text-fg-danger"
                              : "text-fg"
                      )}>
                        <span>
                          {selectedAccountId && isPositive && "+"}
                          {selectedAccountId && !isPositive && "−"}
                          {formatCurrency(Math.abs(amount))}
                        </span>
                        {renderReconciledIndicator(transaction, isProjected || isPlaidPending)}
                      </div>
                      {selectedAccountId && (
                        <div className={cn(
                          "text-xs tabular-nums",
                          isProjected || isPlaidPending
                            ? "text-fg-tertiary italic"
                            : isFuture
                              ? "text-fg-tertiary"
                              : balance >= 0 ? "text-fg-tertiary" : "text-fg-danger"
                        )}>
                          {isPlaidPending ? "—" : formatCurrency(balance)}
                        </div>
                      )}
                    </div>
                    {hasRowActions &&
                      !isProjected &&
                      !isPlaidPending &&
                      hasRowMenuActions(transaction) &&
                      renderOverflowButton(transaction)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {renderRowMenu()}
      </>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
      <table className="w-full table-fixed">
        <colgroup>
          {isInvestmentRegister ? (
            <>
              <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.date} />
              <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.activity} />
              <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.shares} />
              <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.price} />
              <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.amount} />
              {selectedAccountId && <col className={INVESTMENT_TABLE_COLUMN_WIDTHS.balance} />}
            </>
          ) : (
            <>
              <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.date} />
              <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.payee} />
              <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.accounts} />
              <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.amount} />
              {selectedAccountId && <col className={TRANSACTION_TABLE_COLUMN_WIDTHS.balance} />}
            </>
          )}
          {hasRowActions && <col className="w-12" />}
        </colgroup>
        <thead>
          <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider">
            <th className="px-4 py-3 whitespace-nowrap">Date</th>
            {isInvestmentRegister ? (
              <>
                <th className="px-4 py-3">Activity</th>
                <th className="px-4 py-3 text-right">Shares</th>
                <th className="px-4 py-3 text-right">Price</th>
              </>
            ) : (
              <>
                <th className="px-4 py-3">Payee</th>
                <th className="px-4 py-3">Accounts</th>
              </>
            )}
            <th className="px-4 py-3 text-right">Amount</th>
            {selectedAccountId && (
              <th className="px-4 py-3 text-right">Balance</th>
            )}
            {hasRowActions && <th className="px-2 py-3" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-secondary">
          {displayTransactions.map((transaction) => {
            const { isProjected, isPlaidPending, amount, isPositive, balance, isFuture, isHighlightTarget, isTradeOnly } =
              renderTransactionRow(transaction);

            return (
              <tr
                key={transaction.id}
                ref={isHighlightTarget ? highlightRef : undefined}
                onClick={isProjected
                  ? () => transaction.recurringRuleId && onProjectedClick?.(transaction.recurringRuleId)
                  : isPlaidPending
                    ? () => onPlaidPendingClick?.()
                    : () => onEdit(transaction)}
                onMouseDown={isProjected || isPlaidPending ? undefined : handleRowMouseDown}
                onContextMenu={isProjected || isPlaidPending ? undefined : (e) => handleContextMenu(e, transaction)}
                className={cn(
                  "transition-colors",
                  isProjected
                    ? "cursor-pointer border-l-2 border-dashed border-border-future bg-future hover:bg-future-hover"
                    : isPlaidPending
                      ? "cursor-pointer border-l-2 border-dashed border-teal-500/50 bg-teal-500/5 hover:bg-teal-500/10"
                      : "cursor-pointer",
                  !isProjected && !isPlaidPending && isFuture
                    ? "border-l-2 border-border-future bg-future hover:bg-future-hover"
                    : !isProjected && !isPlaidPending && "hover:bg-surface-tertiary",
                  transaction.id === newTransactionId && "animate-new-row",
                  isHighlightTarget && "animate-highlight-row"
                )}
                onAnimationEnd={(e) => {
                  if (e.animationName === "row-highlight") {
                    if (transaction.id === newTransactionId) {
                      onNewTransactionAnimated?.();
                    }
                    if (isHighlightTarget) {
                      onHighlightAnimated?.();
                    }
                  }
                }}
              >
                <td className={cn(
                  "px-4 py-3 text-sm whitespace-nowrap",
                  isProjected ? "text-fg-tertiary italic" : "text-fg-secondary"
                )}>
                  {transaction.isFloating && <span title="Floating — date advances to today until reconciled">~</span>}
                  {formatDate(getEffectiveDate(transaction))}
                </td>
                {isInvestmentRegister ? (
                  renderInvestmentRegisterCells(transaction, {
                    isProjected,
                    isPlaidPending,
                    isFuture,
                  })
                ) : (
                  <>
                    <td className={cn(
                      "px-4 py-3 text-sm",
                      isProjected ? "text-fg-tertiary italic" : "text-fg-secondary"
                    )}>
                      <div className="flex items-center gap-2 min-w-0">
                        {isProjected && renderUpcomingPill()}
                        {isPlaidPending && renderPlaidPill()}
                        {!isProjected && !isPlaidPending && isFuture && renderScheduledPill()}
                        <span className="truncate">
                          {transaction.payee?.name ? (
                            transaction.payee.name
                          ) : (
                            <span className="text-fg-tertiary">Unassigned</span>
                          )}
                        </span>
                        {transaction.checkNumber && renderCheckNumberPill(transaction.checkNumber)}
                        {transaction.notes && <NoteIndicator notes={transaction.notes} />}
                      </div>
                    </td>
                    <td className={cn(
                      "px-4 py-3 text-sm",
                      isProjected ? "text-fg-tertiary italic" : "text-fg-secondary"
                    )}>
                      {isPlaidPending ? (
                        <span className="text-fg-tertiary italic">
                          {transaction.plaidCategory ?? "Unmatched bank transaction"}
                        </span>
                      ) : (
                        renderAccounts(transaction)
                      )}
                    </td>
                  </>
                )}
                <td
                  className={cn(
                    "px-4 py-3 text-sm font-medium whitespace-nowrap",
                    isProjected
                      ? isTradeOnly
                        ? "text-fg-tertiary italic"
                        : selectedAccountId && isPositive
                          ? "text-fg-success-muted italic"
                          : selectedAccountId && !isPositive
                            ? "text-fg-danger-muted italic"
                            : "text-fg-tertiary italic"
                      : isTradeOnly
                        ? "text-fg"
                        : selectedAccountId && isPositive
                          ? "text-fg-success"
                          : selectedAccountId && !isPositive
                            ? "text-fg-danger"
                            : "text-fg"
                  )}
                >
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="tabular-nums">
                      {selectedAccountId && isPositive && "+"}
                      {selectedAccountId && !isPositive && "−"}
                      {formatCurrency(Math.abs(amount))}
                    </span>
                    {renderReconciledIndicator(transaction, isProjected || isPlaidPending)}
                  </div>
                </td>
                {selectedAccountId && (
                  <td
                    className={cn(
                      "px-4 py-3 text-sm text-right font-medium whitespace-nowrap tabular-nums",
                      isProjected || isPlaidPending
                        ? "text-fg-tertiary italic"
                        : isFuture
                          ? "text-fg-tertiary"
                          : balance >= 0 ? "text-fg" : "text-fg-danger"
                    )}
                  >
                    {isPlaidPending ? "—" : formatCurrency(balance)}
                  </td>
                )}
                {hasRowActions && (
                  <td className="px-2 py-3 text-right">
                    {!isProjected &&
                      !isPlaidPending &&
                      hasRowMenuActions(transaction) &&
                      renderOverflowButton(transaction)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* Shared actions menu — opened by right-click or the ⋯ trigger */}
      {renderRowMenu()}
    </>
  );
}
