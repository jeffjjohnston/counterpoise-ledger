import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { exec, rows } from "../helpers/sql";

const NOW = "2026-10-12 05:00:00";

function evaluation(bookId: number, fingerprint: string, status = "ready") {
  return exec(
    `INSERT INTO typesafe_entry_evaluations
       (book_id, account_id, payee_id, revision, fingerprint, attempt, snapshot, status, baseline_key, started_at)
     VALUES (${bookId}, 1, 1, 0, '${fingerprint}', 'a', '{}', '${status}', 'k', '${NOW}')`,
  );
}

describe("typesafe entry schema", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("gives books an entry opt-in that is off", async () => {
    expect(await rows("SELECT typesafe_entry_enabled AS e FROM books WHERE id = 1")).toEqual([{ e: 0 }]);
  });

  it("keeps one evaluation per book and fingerprint", async () => {
    await evaluation(1, "f");
    await expect(evaluation(1, "f")).rejects.toThrow(/UNIQUE/);
  });

  it("refuses an unknown status, outcome or source", async () => {
    await expect(evaluation(1, "g", "done")).rejects.toThrow(/CHECK/);
    const outcome = (value: string, source: string) => exec(
      `INSERT INTO typesafe_entry_outcomes (book_id, evaluation_id, outcome, source, chip_visible, decided_at)
       VALUES (1, NULL, '${value}', '${source}', 0, '${NOW}')`,
    );
    await expect(outcome("ignored", "history")).rejects.toThrow(/CHECK/);
    await expect(outcome("kept", "guess")).rejects.toThrow(/CHECK/);
    await outcome("kept", "typesafe");
  });

  it("keeps an outcome when its evaluation is deleted", async () => {
    await evaluation(1, "h");
    await exec(`INSERT INTO typesafe_entry_outcomes (book_id, evaluation_id, outcome, source, chip_visible, decided_at)
                VALUES (1, 1, 'kept', 'typesafe', 1, '${NOW}')`);
    await exec("DELETE FROM typesafe_entry_evaluations WHERE id = 1");
    expect(await rows("SELECT evaluation_id AS e FROM typesafe_entry_outcomes")).toEqual([{ e: null }]);
  });
});
