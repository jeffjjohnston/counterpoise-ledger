import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  openReportDatabase,
  summarizeTypeSafe,
  typeSafeReport,
} from "@/lib/typesafe/report";
import type { MatchSnapshot } from "@/lib/typesafe/types";
import type { TypeSafeDecision, TypeSafeEvaluation } from "@/types/db";
import { createBook, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { insert, rows } from "../helpers/sql";
import { workerDatabasePath } from "../helpers/test-database";

// The report of `npm run typesafe:report` reads the SQLite file that the
// server writes. These cases write the rows as the server does and read them
// back through the report.

const pick = (choice: string) => ({ choice, probabilities: { [choice]: 1 }, confidence: 1 });

const snapshot: MatchSnapshot = {
  bookId: 1,
  linkId: 1,
  reconciliationId: 1,
  revision: 0,
  mappedAccountId: 1,
  effectiveDay: "2026-08-01",
  model: "jev-1.13.0",
  promptVersion: "plaid-match-v3",
  merchantSeenBefore: true,
  bank: { merchant: "X", name: "X", amountCents: -100, authorizedDate: null, postedDate: "2026-08-01", currency: "USD" },
  baselineIds: [42],
  candidates: [
    { label: "candidate_1", transactionId: 42, payee: "X", date: "2026-08-01", amountCents: -100, counterpartAccounts: [] },
  ],
  payeeOptions: [{ label: "payee_1", payeeId: 3, name: "X", source: "existing" }],
  categoryOptions: [{ label: "category_1", accountId: 7, name: "Food", kind: "expense" }],
  baselineCategoryId: 7,
};

let sequence = 0;
async function evaluation(values: Partial<TypeSafeEvaluation> = {}) {
  sequence += 1;
  return insert<TypeSafeEvaluation>("typesafe_evaluations", {
    bookId: 1,
    reconciliationId: sequence,
    linkId: 1,
    revision: 0,
    fingerprint: `f${sequence}`,
    attempt: `a${sequence}`,
    snapshot,
    status: "ready",
    startedAt: new Date("2026-08-01T10:00:00Z"),
    ...values,
  });
}

async function decision(evaluationId: number, values: Partial<TypeSafeDecision> = {}) {
  await insert("typesafe_decisions", {
    bookId: 1,
    reconciliationId: 1,
    evaluationId,
    action: "create",
    suggestionVisible: true,
    decidedAt: new Date("2026-08-01T10:01:00Z"),
    ...values,
  });
}

function report(bookId: number) {
  const db = openReportDatabase(workerDatabasePath());
  try {
    return typeSafeReport(db, bookId);
  } finally {
    db.close();
  }
}

describe("typeSafeReport on SQLite", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("adds the archived counts to a summary of the stored records of one book", async () => {
    const other = await createBook({ name: "Other" });
    // No match, so Jev proposes a new transaction, and the user creates it in one click.
    const created = await evaluation({
      choice: "none",
      usage: { input_tokens: 120, output_tokens: 8 },
      latencyMs: 900,
      answers: { match: pick("none"), payee: pick("payee_1"), category: pick("category_1") },
      displayedAt: new Date("2026-08-01T10:00:02Z"),
    });
    await decision(created.id, { acceptedSuggestion: true, proposalPayeeKept: true, proposalCategoryKept: true });
    const matched = await evaluation({ choice: "candidate_1", answers: { match: pick("candidate_1") } });
    await decision(matched.id, { action: "match", transactionId: 42 });
    await decision(matched.id, { action: "unlink", transactionId: 42, decidedAt: new Date("2026-08-02T00:00:00Z") });
    await evaluation({ status: "error", errorCode: "timeout", latencyMs: 5000 });
    await evaluation({ bookId: other.id });
    await insert("typesafe_aggregates", { bookId: 1, counts: { evaluations: 5, legacy_key: 1 } });

    const result = report(1);

    // The summary of the same rows, read by the test helpers, is the expected result.
    const stored = await rows<TypeSafeEvaluation>("SELECT * FROM typesafe_evaluations WHERE book_id = 1 ORDER BY id");
    const decisions = await rows<TypeSafeDecision>("SELECT * FROM typesafe_decisions ORDER BY id");
    const expected: Record<string, number> = { evaluations: 5, legacy_key: 1 };
    for (const [key, value] of Object.entries(summarizeTypeSafe(stored, decisions))) {
      expected[key] = (expected[key] ?? 0) + value;
    }
    expect(result.bookId).toBe(1);
    expect(result.counts).toEqual(expected);
    expect(result.counts).toMatchObject({
      evaluations: 8,
      status_ready: 2,
      status_error: 1,
      input_tokens: 120,
      latency_total_ms: 5900,
      proposal_one_click_creates: 1,
      jev_agrees_with_user: 1,
      subsequently_unlinked: 1,
      legacy_key: 1,
    });
    expect(report(other.id).counts).toMatchObject({ evaluations: 1 });
  });

  it("reads more than one page of records", async () => {
    for (let i = 0; i < 1005; i++) await evaluation();
    expect(report(1).counts).toMatchObject({ evaluations: 1005, outcome_unknown: 1005 });
  });

  it("gives empty counts for a book without records", () => {
    expect(report(1).counts).toEqual({});
  });

  it("opens the database read-only", () => {
    const db = openReportDatabase(workerDatabasePath());
    try {
      expect(() => db.exec("DELETE FROM typesafe_evaluations")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  it("prints the report from the npm script on the file that DATABASE_PATH names", async () => {
    await evaluation();
    const result = spawnSync("npx", ["tsx", "scripts/typesafe-report.ts", "--book-id", "1"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_PATH: workerDatabasePath() },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ bookId: 1, counts: { evaluations: 1 } });

    const missing = spawnSync("npx", ["tsx", "scripts/typesafe-report.ts", "--book-id", "1"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_PATH: `${workerDatabasePath()}.missing` },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/No database at/);
  });
});
