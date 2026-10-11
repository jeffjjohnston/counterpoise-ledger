import { readFileSync } from "node:fs";
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

// The hand-worked cases that the Rust summary also reads (`summarize` in
// rust-api/server/src/typesafe.rs). The same events must give the same counts.
interface FixtureEvaluation {
  id: number;
  status: Evaluation["status"];
  snapshot: string;
  choice?: string;
  usage?: Evaluation["usage"];
  answers?: Evaluation["answers"];
  displayedAt?: string;
  latencyMs?: number;
}
interface FixtureDecision {
  evaluationId?: number;
  action: string;
  transactionId?: number;
  suggestionVisible?: boolean;
  acceptedSuggestion?: boolean;
  proposalPayeeKept?: boolean;
  proposalCategoryKept?: boolean;
  activeReviewMs?: number;
  decidedAt: string;
}
/** The counts in key order (a NaN count is null), or a TypeError. */
interface Outcome {
  expected?: Record<string, number | null>;
  error?: boolean;
}
interface History {
  name: string;
  evaluations: FixtureEvaluation[];
  decisions: FixtureDecision[];
}
interface Fixture {
  snapshots: Record<string, Evaluation["snapshot"]>;
  cases: (History & Outcome)[];
}

const fixture = JSON.parse(
  readFileSync("tests/fixtures/typesafe-summary.json", "utf8"),
) as Fixture;
const utc = (text: string) => new Date(`${text.replace(" ", "T")}Z`);

function fixtureEvaluation(row: FixtureEvaluation): Evaluation {
  return evaluation(row.id, {
    status: row.status,
    snapshot: fixture.snapshots[row.snapshot],
    choice: row.choice ?? null,
    usage: row.usage ?? null,
    answers: row.answers ?? null,
    displayedAt: row.displayedAt ? utc(row.displayedAt) : null,
    latencyMs: row.latencyMs ?? null,
  });
}

function fixtureDecision(row: FixtureDecision, index: number): Decision {
  return {
    id: index + 1,
    bookId: 1,
    reconciliationId: 1,
    evaluationId: row.evaluationId ?? null,
    action: row.action,
    transactionId: row.transactionId ?? null,
    suggestionVisible: row.suggestionVisible ?? false,
    acceptedSuggestion: row.acceptedSuggestion ?? false,
    proposalPayeeKept: row.proposalPayeeKept ?? null,
    proposalCategoryKept: row.proposalCategoryKept ?? null,
    activeReviewMs: row.activeReviewMs ?? null,
    decidedAt: utc(row.decidedAt),
  };
}

function expectOutcome(history: History, outcome: Outcome) {
  const summarize = () =>
    summarizeTypeSafe(
      history.evaluations.map(fixtureEvaluation),
      history.decisions.map(fixtureDecision),
    );
  if (outcome.error) {
    expect(summarize).toThrow(TypeError);
    return;
  }
  // The JSON text compares the key order too, and writes a NaN count as null.
  expect(JSON.stringify(summarize())).toBe(JSON.stringify(outcome.expected));
}

describe("summarizeTypeSafe on the shared hand-worked cases", () => {
  it.each(fixture.cases)("$name", (testCase) => expectOutcome(testCase, testCase));
});
