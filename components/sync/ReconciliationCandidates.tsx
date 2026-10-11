"use client";

import { Button } from "@/components/ui/Button";
import { formatCurrency, formatDate } from "@/lib/wasm-client";
import { cn } from "@/lib/utils";
import type { SyncMatchCandidate } from "@/types";

export type MatchAction = { transactionId: number; action: "match" | "match_update_amount" };

type MatchActionsProps = {
  candidate: SyncMatchCandidate;
  submitting: boolean;
  matchingAction: MatchAction | null;
  onMatch: (action: MatchAction) => void;
  size?: "sm";
};

function MatchActions({ candidate, submitting, matchingAction, onMatch, size }: MatchActionsProps) {
  const disabled = submitting || candidate.alreadyLinked;
  const title = candidate.alreadyLinked ? "Already matched to another synced transaction" : undefined;
  const matching = matchingAction?.transactionId === candidate.transactionId ? matchingAction.action : null;
  return (
    <div className="flex flex-col gap-1.5 shrink-0">
      <Button size={size} disabled={disabled} title={title}
        onClick={() => onMatch({ action: "match", transactionId: candidate.transactionId })}>
        {matching === "match" ? "Matching…" : "Match"}
      </Button>
      {candidate.amountDelta !== 0 && candidate.splitCount === 2 && (
        <Button size="sm" variant="secondary" disabled={disabled} title={title}
          onClick={() => onMatch({ action: "match_update_amount", transactionId: candidate.transactionId })}>
          {matching === "match_update_amount" ? "Matching…" : `Match & Update ${formatCurrency(Math.abs(candidate.expectedAmount))}`}
        </Button>
      )}
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

/** Candidate ranking stays server-owned; disclosure state stays with the selected queue item. */
export function ReconciliationCandidates({ candidates, showOthers, onToggleOthers, submitting, matchingAction, onMatch }: Props) {
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
            <MatchActions candidate={bestMatch} submitting={submitting} matchingAction={matchingAction} onMatch={onMatch} />
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
                        <p className="text-sm font-semibold text-fg truncate">
                          {candidate.payeeName || candidate.description || "(No description)"}
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
                      <MatchActions candidate={candidate} submitting={submitting} matchingAction={matchingAction} onMatch={onMatch} size="sm" />
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
