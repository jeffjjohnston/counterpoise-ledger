import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { exec, rows, scalar } from "../helpers/sql";

const NOW = "2026-10-12 05:00:00";

function review(bookId: number, status: string) {
  return exec(
    `INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
     VALUES (${bookId}, 'manual', '2026-10-05', '2026-10-11', '${status}', 0, '${NOW}')`,
  );
}

describe("weekly review schema", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("gives books an opt-in that is off, and a revision of 0", async () => {
    expect(await rows("SELECT weekly_review_enabled AS e, weekly_review_revision AS r FROM books WHERE id = 1"))
      .toEqual([{ e: 0, r: 0 }]);
  });

  it("allows one running review per book", async () => {
    await review(1, "running");
    await expect(review(1, "running")).rejects.toThrow(/UNIQUE/);
    await review(1, "complete");
  });

  it("refuses an unknown status, source, kind or category", async () => {
    await expect(review(1, "paused")).rejects.toThrow(/CHECK/);
    await review(1, "complete");
    const insertItem = (kind: string, category: string) => exec(
      `INSERT INTO weekly_review_items (book_id, review_id, position, kind, category, title, detail, transaction_ids, fingerprint)
       VALUES (1, 1, 0, '${kind}', '${category}', 't', 'd', '[]', 'f')`,
    );
    await expect(insertItem("note", "other")).rejects.toThrow(/CHECK/);
    await expect(insertItem("check", "fraud")).rejects.toThrow(/CHECK/);
    await insertItem("check", "duplicate");
  });

  it("deletes the items with their review, and the reviews with their book", async () => {
    await review(1, "complete");
    await exec(`INSERT INTO weekly_review_items (book_id, review_id, position, kind, category, title, detail, transaction_ids, fingerprint)
                VALUES (1, 1, 0, 'insight', 'other', 't', 'd', '[]', 'f')`);
    await exec("DELETE FROM weekly_reviews WHERE id = 1");
    expect(await scalar("SELECT COUNT(*) FROM weekly_review_items")).toBe(0);
    await review(1, "complete");
    await exec("DELETE FROM books WHERE id = 1");
    expect(await scalar("SELECT COUNT(*) FROM weekly_reviews")).toBe(0);
  });

  it("refuses an item whose review is in another book", async () => {
    await exec(`INSERT INTO books (user_id, name, created_at, updated_at) VALUES (1, 'Other', '${NOW}', '${NOW}')`);
    await review(2, "complete");
    await expect(exec(
      `INSERT INTO weekly_review_items (book_id, review_id, position, kind, category, title, detail, transaction_ids, fingerprint)
       VALUES (1, 1, 0, 'insight', 'other', 't', 'd', '[]', 'f')`,
    )).rejects.toThrow(/FOREIGN KEY/);
  });
});
