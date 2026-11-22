"use client";

import { Button } from "@/components/ui/Button";
import { formatCurrency, formatDate } from "@/lib/wasm-client";
import { cn } from "@/lib/utils";
import type { SyncMatchCandidate, SyncReconciliationItem } from "@/types";

export type MatchAction = { transactionId: number; action: "match" | "match_update_amount" };

/**
 * A link always joins equal amounts (the server refuses any other link). On
 * a candidate with a different amount, the match must also change the amount
 * to the bank amount (match_update_amount). The server can change it only on
 * a transaction with 2 splits that is not an investment transaction. On any
 * other transaction the user must change the splits first, so there is no
 * match action: `null`.
 */
export function candidateAction(candidate: SyncMatchCandidate): MatchAction["action"] | null {
  if (candidate.amountDelta === 0) return "match";
  return candidate.splitCount === 2 && !candidate.isInvestment ? "match_update_amount" : null;
}

/** The penalty that `score()` in rust-api/server/src/routes/reconcile.rs gives an already-linked candidate. */
const ALREADY_LINKED_PENALTY = 80;

/**
 * After a decision links `transactionId` on link `linkId`, the candidates of
 * the other loaded rows on that link are stale: they show the transaction as
 * free, and the server refuses a second link to it. This marks it as linked
 * on those rows and ranks the candidates again as `match_candidates()` does
 * (score, then amount difference, then day difference). Without it, two equal
 * bank rows (two equal charges on one day) both offer the same transaction.
 */
export function markCandidateLinked(
  items: SyncReconciliationItem[],
  linkId: number,
  transactionId: number,
  resolvedId: number
): SyncReconciliationItem[] {
  return items.map((item) => {
    if (item.id === resolvedId || item.plaidAccountLinkId !== linkId) return item;
    if (!item.candidates.some((c) => c.transactionId === transactionId && !c.alreadyLinked)) return item;
    const candidates = item.candidates
      .map((c) =>
        c.transactionId === transactionId && !c.alreadyLinked
          ? { ...c, alreadyLinked: true, score: c.score - ALREADY_LINKED_PENALTY, scoreTags: [...c.scoreTags, "already_linked"] }
          : c
      )
      .sort((a, b) => b.score - a.score || a.amountDelta - b.amountDelta || Math.abs(a.dayDelta) - Math.abs(b.dayDelta));
    return { ...item, candidates };
  });
}

/** Why a candidate with a different amount cannot be matched. */
export function cannotMatchTitle(candidate: SyncMatchCandidate): string {
  return candidate.isInvestment
    ? "The amounts are different, and this is an investment transaction. Change its amount to the bank amount first."
    : "The amounts are different, and this transaction has more than 2 splits. Change the splits to the bank amount first.";
}

/**
 * The main action on the transaction that a row the bank changed is still
 * linked to. Match there would keep the same link, so the choice is between
 * Keep (keep_local: the flag goes, the transaction does not change) when the
 * amounts are equal, and Update (match_update_amount: the same link, with the
 * bank amount) when they are different. Keep is not available when the
 * amounts are different, and with more than 2 splits there is no action:
 * the user changes the splits or unlinks. Enter in the modal does the same
 * action.
 */
export function linkedAction(candidate: SyncMatchCandidate): "keep_local" | "match_update_amount" | null {
  const action = candidateAction(candidate);
  return action === "match" ? "keep_local" : action;
}

type MatchActionsProps = {
  candidate: SyncMatchCandidate;
  submitting: boolean;
  matchingAction: MatchAction | null;
  onMatch: (action: MatchAction) => void;
  /** The transaction that a row the bank changed is still linked to (see `linkedAction`). */
  linkedTransactionId: number | null;
  onKeep: () => void;
  size?: "sm";
};

function MatchActions({ candidate, submitting, matchingAction, onMatch, linkedTransactionId, onKeep, size }: MatchActionsProps) {
  const disabled = submitting || candidate.alreadyLinked;
  const title = candidate.alreadyLinked ? "Already matched to another synced transaction" : undefined;
  const matching = matchingAction?.transactionId === candidate.transactionId ? matchingAction.action : null;
  const update = `${formatCurrency(Math.abs(candidate.expectedAmount))}`;
  if (candidate.transactionId === linkedTransactionId) {
    const linked = linkedAction(candidate);
    if (linked === "keep_local") {
      return (
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size={size} disabled={submitting} title="Keep the link and leave this transaction as it is" onClick={onKeep}>
            Keep
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5 shrink-0">
        <Button size={size} disabled={submitting || linked === null}
          title={linked === null ? cannotMatchTitle(candidate) : "Keep the link and change the amount to the bank amount"}
          onClick={() => onMatch({ action: "match_update_amount", transactionId: candidate.transactionId })}>
          {matching === "match_update_amount" ? "Updating…" : `Update to ${update}`}
        </Button>
      </div>
    );
  }
  const action = candidateAction(candidate);
  return (
    <div className="flex flex-col gap-1.5 shrink-0">
      <Button size={size} disabled={disabled || action === null}
        title={action === null ? cannotMatchTitle(candidate) : title}
        onClick={() => action && onMatch({ action, transactionId: candidate.transactionId })}>
        {matching ? "Matching…" : action === "match_update_amount" ? `Match & Update ${update}` : "Match"}
      </Button>
    </div>
  );
}

// The server already scores and ranks every candidate. These are the tags
// `score()` emits (rust-api/server/src/routes/reconcile.rs); anything not listed
// is deliberately not shown, because a tag with no plain-English reading is
// worse than no chip.
const SCORE_TAG_LABELS: Record<string, string> = {
  exact_amount: "exact amount",
  amount_close: "amount close",
  same_day: "same day",
  date_close: "date close",
  name_exact: "same payee",
  name_similar: "similar payee",
};

function candidateChips(candidate: SyncMatchCandidate): string[] {
  return candidate.scoreTags
    .map((tag) => SCORE_TAG_LABELS[tag])
    .filter((label): label is string => !!label);
}

// The disclosure chevron used to fold the "other candidates" list and the
// Create form. Matches the toggle already shipped in
// components/transactions/PlaidBanner.tsx, so a folded section on this
// screen looks like a folded section everywhere else.
export function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={cn("h-3.5 w-3.5 flex-none transition-transform", expanded && "rotate-180")}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path d="M5 7.5 10 12.5 15 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Props = Omit<MatchActionsProps, "candidate" | "size"> & {
  candidates: SyncMatchCandidate[];
  showOthers: boolean;
  onToggleOthers: () => void;
};

/** A chip on the candidate that the row is linked to now. */
function LinkedChip() {
  return (
    <span className="inline-flex items-center rounded-full bg-surface-tertiary px-2 py-0.5 text-xs font-medium text-fg-secondary">
      linked now
    </span>
  );
}

/** Candidate ranking stays server-owned; disclosure state stays with the selected queue item. */
export function ReconciliationCandidates({ candidates, showOthers, onToggleOthers, submitting, matchingAction, onMatch, linkedTransactionId, onKeep }: Props) {
  const actions = { submitting, matchingAction, onMatch, linkedTransactionId, onKeep };
  const bestMatch = candidates[0] ?? null;
  const otherCandidates = candidates.slice(1);
  return (
    <>
      {bestMatch && (
        <div data-testid="best-match" className="overflow-hidden rounded-lg border border-accent">
          <div className="flex flex-wrap items-center gap-2 border-b border-accent bg-accent-subtle px-3.5 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-accent">
              Best match
            </span>
            {candidateChips(bestMatch).map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center rounded-full bg-success-subtle px-2 py-0.5 text-xs font-medium text-fg-success"
              >
                {chip}
              </span>
            ))}
            {bestMatch.transactionId === linkedTransactionId && <LinkedChip />}
          </div>
          <div className="flex items-center gap-4 p-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-fg">
                {bestMatch.payeeName || bestMatch.description || "(No description)"}
              </p>
              <p className="mt-0.5 text-13 text-fg-secondary">
                {formatDate(bestMatch.date)}
                {bestMatch.counterpartAccountNames.length > 0
                  ? ` · ${bestMatch.counterpartAccountNames.join(", ")}`
                  : ""}
                {" · "}
                <span className="tabular-nums">{formatCurrency(bestMatch.linkedSplitAmount)}</span>
              </p>
            </div>
            <MatchActions candidate={bestMatch} {...actions} />
          </div>
        </div>
      )}

      {candidates.length === 0 && (
        <p className="text-sm text-fg-secondary">No likely matches found.</p>
      )}

      {otherCandidates.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showOthers}
            onClick={() => onToggleOthers()}
            className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-tertiary"
          >
            <DisclosureChevron expanded={showOthers} />
            <span className="font-medium text-fg">
              {otherCandidates.length} other candidate{otherCandidates.length === 1 ? "" : "s"}
            </span>
            <span className="ml-auto text-xs text-fg-tertiary">
              closest is {Math.abs(otherCandidates[0].dayDelta)} day
              {Math.abs(otherCandidates[0].dayDelta) === 1 ? "" : "s"} out,{" "}
              {formatCurrency(otherCandidates[0].amountDelta)} apart
            </span>
          </button>
          {showOthers && (
            <div className="mt-2 space-y-2">
              {otherCandidates.map((candidate) => {
                const chips = candidateChips(candidate);
                return (
                  <div
                    key={candidate.transactionId}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                          <span className="truncate">
                            {candidate.payeeName || candidate.description || "(No description)"}
                          </span>
                          {candidate.transactionId === linkedTransactionId && <LinkedChip />}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-sm text-fg-secondary">
                          <span>{formatDate(candidate.date)}</span>
                          {chips.length > 0 && (
                            <>
                              <span className="text-fg-tertiary">·</span>
                              <span>{chips.join(" · ")}</span>
                            </>
                          )}
                        </div>
                        {candidate.counterpartAccountNames.length > 0 && (
                          <p className="text-sm text-fg-secondary mt-1">
                            Counterpart: {candidate.counterpartAccountNames.join(", ")}
                          </p>
                        )}
                      </div>
                      <MatchActions candidate={candidate} {...actions} size="sm" />
                    </div>
                    {candidate.alreadyLinked && (
                      <p className="text-xs text-fg-tertiary mt-2">
                        Already matched to another synced transaction
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

    </>
  );
}
