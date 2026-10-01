import { describe, expect, it } from "vitest";
import { summarizeTypeSafe } from "@/lib/typesafe/report";
import type { TypeSafeDecision as Decision, TypeSafeEvaluation as Evaluation } from "@/types/db";

const pick = (choice: string) => ({ choice, probabilities: { [choice]: 1 }, confidence: 1 });

function evaluation(id: number, overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    id,
    bookId: 1,
    reconciliationId: id,
    linkId: 1,
    revision: 1,
    fingerprint: `f${id}`,
    attempt: `a${id}`,
    snapshot: {
      bookId: 1,
      linkId: 1,
      reconciliationId: id,
      revision: 1,
      mappedAccountId: 1,
      effectiveDay: "2026-09-22",
      model: "jev-1.13.0",
      promptVersion: "plaid-match-v2",
      merchantSeenBefore: false,
      bank: {
        merchant: "X",
        name: "X",
        amountCents: -100,
        authorizedDate: null,
        postedDate: "2026-09-20",
        currency: "USD",
      },
      baselineIds: [],
      candidates: [],
      payeeOptions: [{ label: "payee_1", payeeId: 3, name: "X", source: "existing" }],
      categoryOptions: [{ label: "category_1", accountId: 7, name: "Food", kind: "expense" }],
      baselineCategoryId: 7,
    },
    status: "ready",
    choice: null,
    probabilities: null,
    confidence: null,
    usage: null,
    answers: { payee: pick("payee_1"), category: pick("category_1") },
    errorCode: null,
    startedAt: new Date("2026-09-22T10:00:00Z"),
    completedAt: new Date("2026-09-22T10:00:01Z"),
    displayedAt: new Date("2026-09-22T10:00:02Z"),
    latencyMs: 1000,
    ...overrides,
  };
}
function decision(evaluationId: number, overrides: Partial<Decision>): Decision {
  return {
    id: evaluationId,
    bookId: 1,
    reconciliationId: evaluationId,
    evaluationId,
    action: "create",
    transactionId: null,
    suggestionVisible: true,
    acceptedSuggestion: false,
    proposalPayeeKept: null,
    proposalCategoryKept: null,
    activeReviewMs: null,
    decidedAt: new Date("2026-09-22T10:01:00Z"),
    ...overrides,
  };
}

describe("summarizeTypeSafe proposals", () => {
  it("counts one-click creates, unchanged edits, changed edits, and other outcomes", () => {
    const counts = summarizeTypeSafe(
      [evaluation(1), evaluation(2), evaluation(3), evaluation(4)],
      [
        decision(1, { acceptedSuggestion: true, proposalPayeeKept: true, proposalCategoryKept: true }),
        decision(2, { proposalPayeeKept: true, proposalCategoryKept: true }),
        decision(3, { proposalPayeeKept: false, proposalCategoryKept: true }),
        decision(4, { action: "ignore" }),
      ],
    );
    expect(counts).toMatchObject({
      proposals: 4,
      proposals_displayed: 4,
      proposal_category_agrees_with_baseline: 4,
      proposal_one_click_creates: 1,
      proposal_edits_unchanged: 1,
      proposal_edits_changed: 1,
      proposal_edits_changed_payee: 1,
      proposal_shown_then_ignore: 1,
    });
    expect(counts.proposal_edits_changed_category).toBeUndefined();
  });

  it("counts no proposal for a v1 evaluation without answers", () => {
    const v1 = evaluation(5, {
      answers: null,
      snapshot: { ...evaluation(5).snapshot, payeeOptions: undefined, categoryOptions: undefined },
    });
    expect(summarizeTypeSafe([v1], [])).toMatchObject({ evaluations: 1 });
    expect(summarizeTypeSafe([v1], []).proposals).toBeUndefined();
  });
});
