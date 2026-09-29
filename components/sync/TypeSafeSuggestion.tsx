"use client";
import { Button } from "@/components/ui/Button";
import { formatCurrency, formatDate } from "@/lib/wasm-client";
import type { MatchSuggestion, Proposal } from "@/lib/typesafe/types";
import type { SyncMatchCandidate } from "@/types";

export function TypeSafeSuggestion({
  result,
  candidates,
  loading,
  submitting,
  onMatch,
  onCreate,
  onEdit,
  onRefresh,
}: {
  result: MatchSuggestion | null;
  candidates: SyncMatchCandidate[];
  loading: boolean;
  submitting: boolean;
  onMatch: (evaluationId: number) => void;
  onCreate: (evaluationId: number) => void;
  onEdit: (proposal: Proposal) => void;
  onRefresh: () => void;
}) {
  if (loading)
    return (
      <p role="status" className="text-xs text-fg-tertiary">
        Checking for a TypeSafe suggestion…
      </p>
    );
  if (!result || result.status === "disabled" || result.status === "skipped")
    return null;
  if (result.status !== "ready")
    return (
      <div className="text-xs text-fg-tertiary">
        <p>
          TypeSafe suggestions are{" "}
          {result.status === "busy"
            ? "being checked in another request"
            : result.status === "limited"
              ? "at today’s request limit"
              : "temporarily unavailable"}
          . You can reconcile normally.
        </p>
        {result.status !== "limited" && (
          <button type="button" onClick={onRefresh} className="mt-1 underline">
            Check again
          </button>
        )}
      </div>
    );
  const candidate = candidates.find(
    (c) => c.transactionId === result.transactionId,
  );
  const isBest = candidate?.transactionId === candidates[0]?.transactionId;
  return (
    <div
      className="rounded-lg border border-border bg-surface-secondary p-3 space-y-2"
      aria-label="TypeSafe suggestion"
    >
      <p className="text-sm font-semibold text-fg">
        TypeSafe suggestion{" "}
        <span className="font-normal text-fg-tertiary">· Experimental</span>
      </p>
      {result.transactionId === null && result.proposal ? (
        <>
          <p className="text-sm text-fg-secondary">
            No existing transaction matches.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-fg-tertiary">Payee</dt>
            <dd className="text-fg">
              {result.proposal.payee.name}
              {result.proposal.payee.payeeId === null && (
                <span className="text-fg-tertiary"> (new payee)</span>
              )}
            </dd>
            <dt className="text-fg-tertiary">Category</dt>
            <dd className="text-fg">{result.proposal.category.name}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={submitting}
              onClick={() => onCreate(result.evaluationId)}
            >
              Create transaction
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => onEdit(result.proposal!)}
            >
              Edit…
            </Button>
          </div>
        </>
      ) : result.transactionId === null ? (
        <p className="text-sm text-fg-secondary">
          {candidates.length
            ? "TypeSafe found no clear match among these candidates."
            : "TypeSafe has no suggestion for this transaction."}
        </p>
      ) : candidate ? (
        <>
          {isBest ? (
            <p className="text-sm text-fg-secondary">
              TypeSafe also suggests the best match shown below.
            </p>
          ) : (
            <p className="text-sm text-fg-secondary">
              {candidate.payeeName || "Unnamed payee"} ·{" "}
              {formatDate(candidate.date)} ·{" "}
              {formatCurrency(candidate.linkedSplitAmount)}
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={submitting || candidate.alreadyLinked}
            onClick={() => onMatch(result.evaluationId)}
          >
            Match this transaction
          </Button>
        </>
      ) : (
        <p className="text-sm text-fg-secondary">
          This suggestion is no longer available. Refresh and review again.
        </p>
      )}
    </div>
  );
}
