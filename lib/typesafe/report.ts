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

/** Adds `n` (default 1) to the count of `key`. */
type Add = (key: string, n?: number) => void;

/**
 * The counts of a set of evaluations and of the decisions that refer to them.
 * Each evaluation is counted in the same steps as `summarize` in
 * rust-api/server/src/typesafe.rs: request, latency, cost, suggestion,
 * proposal, then the resolution by the user. A count key is in the order
 * that the steps first add it.
 */
export function summarizeTypeSafe(
  evaluations: Evaluation[],
  decisions: Decision[],
): Counts {
  const counts: Counts = {};
  const add: Add = (key, n = 1) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  for (const row of evaluations) countEvaluation(add, row, decisions);
  return counts;
}

/** The counts of one evaluation and its decisions. */
function countEvaluation(add: Add, row: Evaluation, decisions: Decision[]) {
  countRequest(add, row);
  countLatency(add, row.latencyMs);
  countCost(add, row.usage);
  const chosen = countSuggestion(add, row);
  const proposed = countProposal(add, row);
  const outcomes = outcomesOf(decisions, row.id);
  const first = outcomes.find((d) => d.action !== "unlink");
  if (!first) {
    add("outcome_unknown");
    return;
  }
  countResolution(add, first);
  if (proposed && first.suggestionVisible) countProposalResolution(add, first);
  countManualMatch(add, row, first, chosen);
  if (unlinkedAfter(outcomes, first)) add("subsequently_unlinked");
}

/** The request, its status (`status_error` counts the errors), and the merchant familiarity. */
function countRequest(add: Add, row: Evaluation) {
  add("evaluations");
  add(`status_${row.status}`);
  add(
    row.snapshot.merchantSeenBefore
      ? "familiar_merchant_evaluations"
      : "unseen_merchant_evaluations",
  );
}

/** A sample for each request with a measured time. */
function countLatency(add: Add, latencyMs: number | null) {
  if (latencyMs === null) return;
  add("latency_samples");
  add("latency_total_ms", latencyMs);
}

/**
 * The tokens of each request that TypeSafe gave a usage for. A token count
 * that is missing, null or not a number adds 0, as in Rust; the usage is
 * still a sample. See guides/typesafe-experiment.md.
 */
function countCost(add: Add, usage: Evaluation["usage"]) {
  if (!usage) return;
  add("usage_samples");
  add("input_tokens", tokenCount(usage.input_tokens));
  add("output_tokens", tokenCount(usage.output_tokens));
}

const tokenCount = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * The first transaction of the baseline order, or undefined when the
 * snapshot has no `baselineIds` list: no baseline, as in Rust.
 */
function baselineFirst(snapshot: Evaluation["snapshot"]): number | undefined {
  const ids: unknown = (snapshot as { baselineIds?: unknown }).baselineIds;
  return Array.isArray(ids) ? (ids[0] as number | undefined) : undefined;
}

/**
 * A `none` choice, and the chosen candidate compared with the first
 * transaction of the baseline order. Returns the chosen transaction.
 */
function countSuggestion(add: Add, row: Evaluation): number | undefined {
  if (row.choice === "none") add("none_predictions");
  const chosen = row.snapshot.candidates.find(
    (c) => c.label === row.choice,
  )?.transactionId;
  // A snapshot without a baseline counts as a disagreement.
  if (chosen)
    add(
      chosen === baselineFirst(row.snapshot)
        ? "agrees_with_baseline"
        : "differs_from_baseline",
    );
  return chosen;
}

/**
 * A proposed new transaction, its display, and its category compared with
 * the history-based category. Returns true when there is a proposal.
 */
function countProposal(add: Add, row: Evaluation): boolean {
  const proposal = proposalFor(row.snapshot, row.answers);
  if (!proposal) return false;
  add("proposals");
  if (row.displayedAt) add("proposals_displayed");
  const baseline = row.snapshot.baselineCategoryId;
  if (baseline !== undefined && baseline !== null)
    add(
      proposal.category.accountId === baseline
        ? "proposal_category_agrees_with_baseline"
        : "proposal_category_differs_from_baseline",
    );
  return true;
}

/** The decisions of one evaluation in time order. Decisions at the same time keep their given order. */
function outcomesOf(decisions: Decision[], evaluationId: number): Decision[] {
  return decisions
    .filter((d) => d.evaluationId === evaluationId)
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
}

/** The first decision of the user in the UI. */
function countResolution(add: Add, first: Decision) {
  add("ui_decisions");
  add(`ui_action_${first.action}`);
  if (first.suggestionVisible) add("suggestion_visible_decisions");
  if (first.acceptedSuggestion) add("suggestion_button_acceptances");
  if (first.activeReviewMs === null) return;
  add("review_time_samples");
  add("review_time_total_ms", first.activeReviewMs);
}

/**
 * What the user did after a proposal was on the screen. A "kept" value that
 * is unknown (null) is not counted as a change of the payee or the category.
 */
function countProposalResolution(add: Add, first: Decision) {
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

/**
 * A transaction that the user matched, compared with the candidates, the
 * baseline order, and the choice of Jev.
 */
function countManualMatch(
  add: Add,
  row: Evaluation,
  first: Decision,
  chosen: number | undefined,
) {
  const matched = first.transactionId;
  if (first.action !== "match" || matched === null) return;
  add("manual_matches");
  add(
    row.snapshot.candidates.some((c) => c.transactionId === matched)
      ? "manual_match_in_candidates"
      : "manual_match_outside_candidates",
  );
  if (baselineFirst(row.snapshot) === matched) add("baseline_agrees_with_user");
  if (chosen === matched) {
    add("jev_agrees_with_user");
    add(
      row.snapshot.merchantSeenBefore
        ? "familiar_merchant_agrees_with_user"
        : "unseen_merchant_agrees_with_user",
    );
  }
  if (row.choice === "none") add("none_followed_by_manual_match");
}

/** An unlink at the time of the first decision or later. */
function unlinkedAfter(outcomes: Decision[], first: Decision): boolean {
  return outcomes.some(
    (d) => d.action === "unlink" && d.decidedAt >= first.decidedAt,
  );
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
