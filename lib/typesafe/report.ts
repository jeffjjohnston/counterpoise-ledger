/**
 * The operator report over the TypeSafe records (`npm run typesafe:report`).
 * It reads the SQLite database of the server and opens it read-only. The
 * server does the hourly cleanup and keeps the archived counts; see
 * guides/typesafe-experiment.md.
 */
import { DatabaseSync } from "node:sqlite";
import type { TypeSafeDecision, TypeSafeEvaluation } from "@/types/db";
import { proposalFor } from "./questions";

type Evaluation = TypeSafeEvaluation;
type Decision = TypeSafeDecision;
type Counts = Record<string, number>;
type RawRow = Record<string, unknown>;

function merge(a: Counts, b: Counts) {
  for (const [key, value] of Object.entries(b)) a[key] = (a[key] ?? 0) + value;
  return a;
}
export function summarizeTypeSafe(
  evaluations: Evaluation[],
  decisions: Decision[],
): Counts {
  const counts: Counts = {};
  const add = (key: string, n = 1) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  for (const row of evaluations) {
    add("evaluations");
    add(`status_${row.status}`);
    add(
      row.snapshot.merchantSeenBefore
        ? "familiar_merchant_evaluations"
        : "unseen_merchant_evaluations",
    );
    if (row.latencyMs !== null) {
      add("latency_samples");
      add("latency_total_ms", row.latencyMs);
    }
    if (row.usage) {
      add("usage_samples");
      add("input_tokens", row.usage.input_tokens);
      add("output_tokens", row.usage.output_tokens);
    }
    if (row.choice === "none") add("none_predictions");
    const chosen = row.snapshot.candidates.find(
      (c) => c.label === row.choice,
    )?.transactionId;
    if (chosen)
      add(
        chosen === row.snapshot.baselineIds[0]
          ? "agrees_with_baseline"
          : "differs_from_baseline",
      );
    const proposal = proposalFor(row.snapshot, row.answers);
    if (proposal) {
      add("proposals");
      if (row.displayedAt) add("proposals_displayed");
      const baseline = row.snapshot.baselineCategoryId;
      if (baseline !== undefined && baseline !== null)
        add(
          proposal.category.accountId === baseline
            ? "proposal_category_agrees_with_baseline"
            : "proposal_category_differs_from_baseline",
        );
    }
    const outcomes = decisions
      .filter((d) => d.evaluationId === row.id)
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
    const first = outcomes.find((d) => d.action !== "unlink");
    if (!first) {
      add("outcome_unknown");
      continue;
    }
    add("ui_decisions");
    add(`ui_action_${first.action}`);
    if (first.suggestionVisible) add("suggestion_visible_decisions");
    if (first.acceptedSuggestion) add("suggestion_button_acceptances");
    if (first.activeReviewMs !== null) {
      add("review_time_samples");
      add("review_time_total_ms", first.activeReviewMs);
    }
    if (proposal && first.suggestionVisible) {
      if (first.action !== "create") add(`proposal_shown_then_${first.action}`);
      else if (first.acceptedSuggestion) add("proposal_one_click_creates");
      else if (first.proposalPayeeKept && first.proposalCategoryKept)
        add("proposal_edits_unchanged");
      else {
        add("proposal_edits_changed");
        if (first.proposalPayeeKept === false) add("proposal_edits_changed_payee");
        if (first.proposalCategoryKept === false)
          add("proposal_edits_changed_category");
      }
    }
    if (first.action === "match" && first.transactionId !== null) {
      add("manual_matches");
      if (
        row.snapshot.candidates.some(
          (c) => c.transactionId === first.transactionId,
        )
      )
        add("manual_match_in_candidates");
      else add("manual_match_outside_candidates");
      if (row.snapshot.baselineIds[0] === first.transactionId)
        add("baseline_agrees_with_user");
      if (chosen === first.transactionId) {
        add("jev_agrees_with_user");
        add(
          row.snapshot.merchantSeenBefore
            ? "familiar_merchant_agrees_with_user"
            : "unseen_merchant_agrees_with_user",
        );
      }
      if (row.choice === "none") add("none_followed_by_manual_match");
    }
    if (
      outcomes.some(
        (d) => d.action === "unlink" && d.decidedAt >= first.decidedAt,
      )
    )
      add("subsequently_unlinked");
  }
  return counts;
}

/** The database file that the server uses: `DATABASE_PATH`, default `data/counterpoise.db`. */
export function reportDatabasePath(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_PATH || "data/counterpoise.db";
}

/** Opens the database read-only. The report never writes. */
export function openReportDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  // The server can write at the same time. Wait for its lock, do not fail.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** A naive timestamp column holds a UTC wall-clock value. */
function utc(value: unknown): Date | null {
  return typeof value === "string" ? new Date(`${value.replace(" ", "T")}Z`) : null;
}

function json<T>(value: unknown): T | null {
  return typeof value === "string" ? (JSON.parse(value) as T) : null;
}

function flag(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(Number(value));
}

function integer(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** One `typesafe_evaluations` row as the summary reads it. */
export function evaluationFromRow(row: RawRow): Evaluation {
  return {
    id: Number(row.id),
    bookId: Number(row.book_id),
    reconciliationId: Number(row.reconciliation_id),
    linkId: Number(row.link_id),
    revision: Number(row.revision),
    fingerprint: String(row.fingerprint),
    attempt: String(row.attempt),
    snapshot: json<Evaluation["snapshot"]>(row.snapshot)!,
    status: row.status as Evaluation["status"],
    choice: (row.choice as string | null) ?? null,
    probabilities: json<Record<string, number>>(row.probabilities),
    confidence: json<number>(row.confidence),
    usage: json<Evaluation["usage"]>(row.usage),
    answers: json<Evaluation["answers"]>(row.answers),
    errorCode: (row.error_code as string | null) ?? null,
    startedAt: utc(row.started_at)!,
    completedAt: utc(row.completed_at),
    displayedAt: utc(row.displayed_at),
    latencyMs: integer(row.latency_ms),
  };
}

/** One `typesafe_decisions` row as the summary reads it. */
export function decisionFromRow(row: RawRow): Decision {
  return {
    id: Number(row.id),
    bookId: Number(row.book_id),
    reconciliationId: Number(row.reconciliation_id),
    evaluationId: integer(row.evaluation_id),
    action: String(row.action),
    transactionId: integer(row.transaction_id),
    suggestionVisible: flag(row.suggestion_visible) ?? false,
    acceptedSuggestion: flag(row.accepted_suggestion) ?? false,
    proposalPayeeKept: flag(row.proposal_payee_kept),
    proposalCategoryKept: flag(row.proposal_category_kept),
    activeReviewMs: integer(row.active_review_ms),
    decidedAt: utc(row.decided_at)!,
  };
}

/**
 * The counts of one book: the archived counts plus a summary of the records
 * that are still there. It reads in one transaction, so a cleanup that the
 * server runs at the same time cannot count a record twice or lose it.
 */
export function typeSafeReport(db: DatabaseSync, bookId: number) {
  db.exec("BEGIN");
  try {
    const archived = db
      .prepare("SELECT counts FROM typesafe_aggregates WHERE book_id = ?")
      .get(bookId) as { counts: string } | undefined;
    const counts: Counts = { ...json<Counts>(archived?.counts) };
    const page = db.prepare(
      "SELECT * FROM typesafe_evaluations WHERE book_id = ? AND id > ? ORDER BY id LIMIT 1000",
    );
    const decisionsOf = db.prepare(
      "SELECT d.* FROM typesafe_decisions d JOIN json_each(?) e ON d.evaluation_id = e.value",
    );
    let after = 0;
    for (;;) {
      const rows = (page.all(bookId, after) as RawRow[]).map(evaluationFromRow);
      if (!rows.length) break;
      const ids = JSON.stringify(rows.map((r) => r.id));
      const decisions = (decisionsOf.all(ids) as RawRow[]).map(decisionFromRow);
      merge(counts, summarizeTypeSafe(rows, decisions));
      after = rows[rows.length - 1].id;
    }
    return {
      bookId,
      counts,
      interpretation:
        "User agreement and acceptance are assisted-use signals, not independently verified accuracy. Archived counts include records whose details expired after 30 days.",
    };
  } finally {
    db.exec("COMMIT");
  }
}
