import { and, desc, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { issueReports } from "@/db/schema";
import {
  NO_FIELDS_MESSAGE,
  type CreateIssueReportInput,
  type UpdateIssueReportInput,
} from "@/lib/schemas/issue-reports";

// Issue reports live in a meta table keyed by userId, not bookId. Every
// function here filters by userId, the same way the book functions in
// lib/books.ts filter by it.

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class IssueReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueReportValidationError";
  }
}

export class IssueReportNotFoundError extends Error {
  constructor(message: string = "Issue report not found") {
    super(message);
    this.name = "IssueReportNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueReport = typeof issueReports.$inferSelect;

export type ListIssueReportsOptions = {
  /** Return only reports in this status. Omit to return every status. */
  status?: IssueReport["status"];
};

// ---------------------------------------------------------------------------
// createIssueReport — moved from app/api/issue-reports/route.ts (POST)
// ---------------------------------------------------------------------------

export async function createIssueReport(
  db: AppDb,
  userId: number,
  input: CreateIssueReportInput
): Promise<IssueReport> {
  const { description, type, page } = input;

  const [report] = await db
    .insert(issueReports)
    .values({ userId, description, type, page })
    .returning();

  return report;
}

// ---------------------------------------------------------------------------
// listIssueReports — moved from app/api/issue-reports/route.ts (GET)
// ---------------------------------------------------------------------------

export async function listIssueReports(
  db: AppDb,
  userId: number,
  opts: ListIssueReportsOptions = {}
): Promise<IssueReport[]> {
  const conditions = [eq(issueReports.userId, userId)];
  if (opts.status) conditions.push(eq(issueReports.status, opts.status));

  return db
    .select()
    .from(issueReports)
    .where(and(...conditions))
    .orderBy(desc(issueReports.createdAt));
}

// ---------------------------------------------------------------------------
// updateIssueReport — moved from app/api/issue-reports/[id]/route.ts (PUT)
// ---------------------------------------------------------------------------

export async function updateIssueReport(
  db: AppDb,
  userId: number,
  id: number,
  input: UpdateIssueReportInput
): Promise<IssueReport> {
  const { description, status, type } = input;

  const updates: Partial<Pick<IssueReport, "description" | "status" | "type">> = {};
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (type !== undefined) updates.type = type;

  // The route's version of this rule lives in the schema layer, as a
  // `.refine()` on updateIssueReportSchema (see lib/schemas/issue-reports.ts).
  // A caller that reaches this function through the MCP tool spreads the
  // schema's `.shape` into its inputSchema, which drops that top-level
  // refine — so the rule is repeated here. Without it, an empty `input`
  // would reach `db.update(...).set({})`, an empty SET clause that is
  // invalid SQL, not a clean validation message. NO_FIELDS_MESSAGE is
  // imported, not copied, so this message cannot drift from the schema's.
  if (Object.keys(updates).length === 0) {
    throw new IssueReportValidationError(NO_FIELDS_MESSAGE);
  }

  const [updated] = await db
    .update(issueReports)
    .set(updates)
    .where(and(eq(issueReports.id, id), eq(issueReports.userId, userId)))
    .returning();

  if (!updated) throw new IssueReportNotFoundError(`Issue report ${id} not found`);

  return updated;
}

// ---------------------------------------------------------------------------
// deleteIssueReport — moved from app/api/issue-reports/[id]/route.ts (DELETE)
// ---------------------------------------------------------------------------

export async function deleteIssueReport(db: AppDb, userId: number, id: number): Promise<void> {
  const [deleted] = await db
    .delete(issueReports)
    .where(and(eq(issueReports.id, id), eq(issueReports.userId, userId)))
    .returning();

  if (!deleted) throw new IssueReportNotFoundError(`Issue report ${id} not found`);
}
