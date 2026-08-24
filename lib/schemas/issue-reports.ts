import { z } from "zod/v4";

// Shape validation for the meta-level issue-reports resource
// (app/api/issue-reports/**). Business rules that require a database read
// stay in the route handlers:
//   - "Issue report not found" (404, PUT and DELETE) — a report owned by a
//     different user, or a nonexistent id.
// "Invalid ID" (both PUT and DELETE, from Number(id) on the :id path
// segment) is left untouched — the same precedent lib/schemas/accounts.ts
// and lib/schemas/sync.ts establish for path-segment ids not being this
// schema layer's job.

// Value lists mirror the `enum` options on issueReports.type/status in
// db/schema.ts (verified there, not assumed from the routes' own
// hand-written VALID_TYPES/VALID_STATUSES lists — see CLAUDE.md's note on
// `text(col, { enum: [...] })` being TypeScript-only, not DB-enforced).
// Hoisted once and shared by both schemas below, same reasoning
// lib/schemas/accounts.ts gives for `accountSubtypeSchema`.
const issueReportTypeValues = ["bug", "improvement", "other"] as const;
const issueReportStatusValues = ["new", "resolved", "wontfix"] as const;

const ISSUE_REPORT_TYPE_MESSAGE = "Invalid type. Must be one of: bug, improvement, other"; // issue-reports/route.ts:66, issue-reports/[id]/route.ts:55
const ISSUE_REPORT_STATUS_MESSAGE = "Invalid status. Must be one of: new, resolved, wontfix"; // issue-reports/[id]/route.ts:45

const issueReportTypeSchema = z.enum(issueReportTypeValues, {
  error: ISSUE_REPORT_TYPE_MESSAGE,
});
const issueReportStatusSchema = z.enum(issueReportStatusValues, {
  error: ISSUE_REPORT_STATUS_MESSAGE,
});

// ---------------------------------------------------------------------------
// createIssueReportSchema — POST /api/issue-reports
// ---------------------------------------------------------------------------
//
// POST's guards run description -> page -> type, in that order, so fields
// are declared in that order here (issues[0] then lands on the same field
// the original guard sequence would have reported first).
//
// `page` deliberately has no `.trim()`: the original guard is a bare
// `!page || typeof page !== "string"` with no trimming anywhere (unlike
// `description`, which the route both validates and stores trimmed), so a
// whitespace-only page is accepted here exactly as it was before.
//
// `type` defaults to "bug" only when the key is absent or literally
// `undefined` — matching the route's own destructuring default
// (`const { type = "bug" } = body`), which likewise does not apply for an
// explicit `null` (VALID_TYPES.includes(null) is false today, so an
// explicit null 400s both before and after this change).
const DESCRIPTION_REQUIRED_MESSAGE = "Description is required"; // issue-reports/route.ts:52
const PAGE_REQUIRED_MESSAGE = "Page is required"; // issue-reports/route.ts:59

// The top-level `z.object(...)` also takes `{ error:
// DESCRIPTION_REQUIRED_MESSAGE }`. The original route's `const {
// description, type = "bug", page } = body` auto-boxes a non-object body
// (`[]`, `"abc"`, `5`, `true`) without throwing, landing on `description`
// being `undefined` and reporting this exact "required" message at 400
// (only a literal `null` body threw, pre-schema). Without this override,
// zod's own object-shape check would reject those same inputs with its
// generic type-check text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const createIssueReportSchema = z.object(
  {
    description: z
      .string({ error: DESCRIPTION_REQUIRED_MESSAGE })
      .trim()
      .min(1, DESCRIPTION_REQUIRED_MESSAGE)
      .describe("What went wrong or what should improve, in the reporter's own words."),
    page: z
      .string({ error: PAGE_REQUIRED_MESSAGE })
      .min(1, PAGE_REQUIRED_MESSAGE)
      .describe("The app path the report is about, e.g. /b/1/transactions."),
    type: issueReportTypeSchema
      .default("bug")
      .describe("The kind of report: bug, improvement, or other. Defaults to bug."),
  },
  { error: DESCRIPTION_REQUIRED_MESSAGE }
);

export type CreateIssueReportInput = z.infer<typeof createIssueReportSchema>;

// ---------------------------------------------------------------------------
// updateIssueReportSchema — PUT /api/issue-reports/[id]
// ---------------------------------------------------------------------------
//
// PUT's three fields are all optional (only validated/applied when
// present), plus a fourth guard — "No valid fields to update" — that fires
// only when none of the three were provided at all. That's a pure function
// of the body with no DB read, so it becomes a `.refine()` here rather than
// staying a hand-written route check, the same reasoning
// lib/schemas/sync.ts gives for moving reconcileSchema's action-based
// required-field checks into the schema layer.
//
// Verified directly (not assumed) that this refine can't produce a
// misleading issues[0]: zod still runs an object's `.refine()` predicate
// even when a field-level check inside that same object already failed,
// but it appends the refine's issue *after* any field-level issues in the
// returned `issues` array — so whenever a field is actually invalid (e.g.
// `{ description: "" }`), issues[0] is always that field's own message, and
// "No valid fields to update" only ever surfaces as issues[0] when every
// field passed its own (optional) check, i.e. none were provided — matching
// the original, where each field's own guard already returned before the
// trailing `Object.keys(updates).length === 0` check was ever reached.
const DESCRIPTION_EMPTY_MESSAGE = "Description cannot be empty"; // issue-reports/[id]/route.ts:35
// Exported: lib/issue-reports.ts's updateIssueReport() re-checks this same
// rule and must report it with the identical text — see the comment there
// for why the check is duplicated instead of relied on once.
export const NO_FIELDS_MESSAGE = "No valid fields to update"; // issue-reports/[id]/route.ts:64

// The top-level `z.object(...)` also takes `{ error: NO_FIELDS_MESSAGE }`.
// The original route reads `body.description`/`body.status`/`body.type`
// off the parsed body directly (no destructuring) — for a non-object body
// (`[]`, `"abc"`, `5`, `true`), every one of those property reads is
// `undefined` (auto-boxing, not a throw), so `updates` stays `{}` and the
// route reports this exact message at 400 (only a literal `null` body
// threw, pre-schema, since `null.description` throws). Without this
// override, zod's own object-shape check would reject those same inputs
// with its generic type-check text instead of the ported message.
export const updateIssueReportSchema = z
  .object(
    {
      description: z
        .string({ error: DESCRIPTION_EMPTY_MESSAGE })
        .trim()
        .min(1, DESCRIPTION_EMPTY_MESSAGE)
        .optional()
        .describe("New description. Omit to leave it unchanged."),
      status: issueReportStatusSchema
        .optional()
        .describe("New status: new, resolved, or wontfix. Omit to leave it unchanged."),
      type: issueReportTypeSchema
        .optional()
        .describe("New type: bug, improvement, or other. Omit to leave it unchanged."),
    },
    { error: NO_FIELDS_MESSAGE }
  )
  .refine(
    (data) => data.description !== undefined || data.status !== undefined || data.type !== undefined,
    { error: NO_FIELDS_MESSAGE }
  );

export type UpdateIssueReportInput = z.infer<typeof updateIssueReportSchema>;
