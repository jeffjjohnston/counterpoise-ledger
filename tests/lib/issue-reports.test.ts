import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDatabase, resetTestDatabase, createUser } from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import {
  createIssueReport,
  listIssueReports,
  updateIssueReport,
  deleteIssueReport,
  IssueReportValidationError,
  IssueReportNotFoundError,
} from "@/lib/issue-reports";

describe("issue reports shared logic", () => {
  const userId = 1; // seeded by setupTestDatabase/resetTestDatabase

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  describe("createIssueReport", () => {
    it("creates a report owned by the user", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "The register scrolls sideways on iPad",
        type: "bug",
        page: "/b/1/transactions",
      });

      expect(report.userId).toBe(userId);
      expect(report.status).toBe("new");
      expect(report.description).toBe("The register scrolls sideways on iPad");
      expect(report.type).toBe("bug");
      expect(report.page).toBe("/b/1/transactions");
    });
  });

  describe("listIssueReports", () => {
    it("lists only this user's reports", async () => {
      const otherUser = await createUser({ username: "other" });
      await createIssueReport(getDb(), userId, { description: "Mine", type: "bug", page: "/b/1" });
      await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      const mine = await listIssueReports(getDb(), userId);
      expect(mine).toHaveLength(1);
      expect(mine[0].description).toBe("Mine");
    });

    it("returns newest first", async () => {
      await createIssueReport(getDb(), userId, { description: "First", type: "bug", page: "/b/1" });
      await createIssueReport(getDb(), userId, { description: "Second", type: "bug", page: "/b/1" });

      const reports = await listIssueReports(getDb(), userId);
      expect(reports[0].description).toBe("Second");
      expect(reports[1].description).toBe("First");
    });

    it("filters by status when given", async () => {
      const a = await createIssueReport(getDb(), userId, { description: "A", type: "bug", page: "/b/1" });
      await createIssueReport(getDb(), userId, { description: "B", type: "bug", page: "/b/1" });
      await updateIssueReport(getDb(), userId, a.id, { status: "resolved" });

      const resolved = await listIssueReports(getDb(), userId, { status: "resolved" });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].description).toBe("A");
    });
  });

  describe("updateIssueReport", () => {
    it("updates fields on a report the user owns", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      const updated = await updateIssueReport(getDb(), userId, report.id, {
        status: "resolved",
        description: "Fixed now",
      });

      expect(updated.status).toBe("resolved");
      expect(updated.description).toBe("Fixed now");
    });

    it("refuses to update another user's report", async () => {
      const otherUser = await createUser({ username: "other" });
      const theirs = await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      await expect(
        updateIssueReport(getDb(), userId, theirs.id, { status: "resolved" })
      ).rejects.toThrow(IssueReportNotFoundError);
    });

    it("throws IssueReportNotFoundError for a nonexistent id", async () => {
      await expect(
        updateIssueReport(getDb(), userId, 999999, { status: "resolved" })
      ).rejects.toThrow(IssueReportNotFoundError);
    });

    it("throws IssueReportValidationError when no fields are given", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      await expect(updateIssueReport(getDb(), userId, report.id, {})).rejects.toThrow(
        IssueReportValidationError
      );
    });
  });

  describe("deleteIssueReport", () => {
    it("deletes a report the user owns", async () => {
      const report = await createIssueReport(getDb(), userId, {
        description: "Mine",
        type: "bug",
        page: "/b/1",
      });

      await deleteIssueReport(getDb(), userId, report.id);

      const remaining = await listIssueReports(getDb(), userId);
      expect(remaining).toHaveLength(0);
    });

    it("refuses to delete another user's report", async () => {
      const otherUser = await createUser({ username: "other" });
      const theirs = await createIssueReport(getDb(), otherUser.id, {
        description: "Theirs",
        type: "bug",
        page: "/b/1",
      });

      await expect(deleteIssueReport(getDb(), userId, theirs.id)).rejects.toThrow(
        IssueReportNotFoundError
      );

      const stillTheirs = await listIssueReports(getDb(), otherUser.id);
      expect(stillTheirs).toHaveLength(1);
    });
  });
});
