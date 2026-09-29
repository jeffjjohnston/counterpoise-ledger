import type { AppDb } from "@/db";
import {
  typesafeAggregates,
  typesafeDecisions,
  typesafeEvaluations,
  typesafeQuotas,
} from "@/db/schema";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { lockTypeSafeBook } from "./settings";
import { proposalFor } from "./questions";

type Evaluation = typeof typesafeEvaluations.$inferSelect;
type Decision = typeof typesafeDecisions.$inferSelect;
type Counts = Record<string, number>;

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

export async function typeSafeReport(db: AppDb, bookId: number) {
  return db.transaction(
    async (tx) => {
      const [archived] = await tx
        .select()
        .from(typesafeAggregates)
        .where(eq(typesafeAggregates.bookId, bookId));
      const counts = { ...archived?.counts };
      let after = 0;
      for (;;) {
        const rows = await tx
          .select()
          .from(typesafeEvaluations)
          .where(
            and(
              eq(typesafeEvaluations.bookId, bookId),
              gt(typesafeEvaluations.id, after),
            ),
          )
          .orderBy(asc(typesafeEvaluations.id))
          .limit(1000);
        if (!rows.length) break;
        const decisions = await tx
          .select()
          .from(typesafeDecisions)
          .where(
            inArray(
              typesafeDecisions.evaluationId,
              rows.map((r) => r.id),
            ),
          );
        merge(counts, summarizeTypeSafe(rows, decisions));
        after = rows[rows.length - 1].id;
      }
      return {
        bookId,
        counts,
        interpretation:
          "User agreement and acceptance are assisted-use signals, not independently verified accuracy. Archived counts include records whose details expired after 30 days.",
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** One bounded batch; scheduled hourly, including when TypeSafe is disabled. */
export async function cleanupTypeSafe(db: AppDb, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const batch = await db
    .select({ id: typesafeEvaluations.id, bookId: typesafeEvaluations.bookId })
    .from(typesafeEvaluations)
    .where(lt(typesafeEvaluations.startedAt, cutoff))
    .orderBy(asc(typesafeEvaluations.id))
    .limit(1000);
  let deleted = 0;
  for (const bookId of [...new Set(batch.map((r) => r.bookId))]) {
    deleted += await db.transaction(async (tx) => {
      await lockTypeSafeBook(tx, bookId);
      const rows = await tx
        .select()
        .from(typesafeEvaluations)
        .where(
          and(
            eq(typesafeEvaluations.bookId, bookId),
            inArray(
              typesafeEvaluations.id,
              batch.filter((r) => r.bookId === bookId).map((r) => r.id),
            ),
            lt(typesafeEvaluations.startedAt, cutoff),
          ),
        );
      if (!rows.length) return 0;
      const ids = rows.map((r) => r.id);
      const decisions = await tx
        .select()
        .from(typesafeDecisions)
        .where(inArray(typesafeDecisions.evaluationId, ids));
      const [archived] = await tx
        .select()
        .from(typesafeAggregates)
        .where(eq(typesafeAggregates.bookId, bookId));
      const counts = merge(
        { ...archived?.counts },
        summarizeTypeSafe(rows, decisions),
      );
      await tx
        .insert(typesafeAggregates)
        .values({ bookId, counts })
        .onConflictDoUpdate({
          target: typesafeAggregates.bookId,
          set: { counts },
        });
      await tx
        .delete(typesafeEvaluations)
        .where(inArray(typesafeEvaluations.id, ids));
      return rows.length;
    });
  }
  // Quotas carry no transaction data. Retain today's quota across clear-data.
  await db
    .delete(typesafeQuotas)
    .where(lt(typesafeQuotas.day, cutoff.toISOString().slice(0, 10)));
  return { deleted, batchLimit: 1000 };
}
