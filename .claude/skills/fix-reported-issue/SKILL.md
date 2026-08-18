---
name: fix-reported-issue
description: >
  Triage and fix the oldest unresolved issue from the production issue_reports table.
  Use this skill whenever the user asks to check for reported issues, fix a reported bug,
  address user feedback, work on issue reports, or triage production issues. Also use when
  the user says things like "check prod for issues", "any new bugs?", "fix the next issue",
  or "work on reported issues".
---

> **Maintainer setup — adapt paths for your fork.** Container names are pinned
> by `name:` in `docker-compose.yml`, so those are the same in every checkout.

# Fix Reported Issue

This skill handles the full lifecycle of a user-reported issue: find it, fix it, verify the fix, commit, and mark it resolved. The issue_reports table lives in the production PostgreSQL database and is populated by in-app user feedback.

## Workflow

### 1. Get production database credentials

Read `.env.production.local` in the project root for credentials. The `DATABASE_URL` uses the Docker-internal hostname (`postgres`), but the production database is exposed to the host via Docker's port mapping, so connect to `localhost` instead.

```bash
PGPASSWORD=counterpoise psql -h localhost -U counterpoise -d counterpoise
```

### 2. Query for the oldest unresolved issue

```sql
SELECT * FROM issue_reports
WHERE status = 'new'
ORDER BY created_at ASC
LIMIT 1;
```

If no issues are found, tell the user there are no open issues and stop.

### 3. Understand the issue

The `issue_reports` schema:
- `id` — primary key
- `userId` — who reported it
- `description` — what the user wants (the main instruction)
- `type` — `bug`, `improvement`, or `other`
- `page` — the app route where the issue was reported (e.g., `/b/2/sync`)
- `status` — `new`, `resolved`, or `wontfix`
- `createdAt` — when it was reported

Use the `page` field to locate the relevant component/page code. The app routes map to:
- `/b/[bookId]/...` pages → `/app/b/[bookId]/.../page.tsx`
- Components are in `/components/` organized by domain (accounts, transactions, securities, sync, reports, etc.)

### 4. Fix the issue

Investigate the relevant code, understand the current behavior, and implement the fix. Follow these principles:

- **Read before writing.** Understand the existing code and patterns before making changes.
- **Reuse existing components.** Check `/components/ui/` for reusable components (autocompletes, inputs, modals, etc.) before building something new.
- **Match existing patterns.** Look at how similar features work elsewhere in the codebase for guidance on approach.
- **Keep changes minimal.** Fix what the issue asks for — don't refactor surrounding code or add unrelated improvements.

### 5. Verify the fix

Run lint, type-check, and tests — in that order. Fix any failures before proceeding to the next check.

```bash
npm run lint
npx tsc --noEmit
npm test
```

If tests fail due to your changes, fix them. If tests fail for unrelated reasons, note it but proceed.

### 6. Commit the change

Stage only the files you changed and commit with a descriptive message. Reference the issue report ID in the commit body.

### 7. Mark the issue as resolved

```sql
UPDATE issue_reports SET status = 'resolved' WHERE id = <issue_id>;
```

Confirm the update succeeded (should show `UPDATE 1`).

### 8. Report to the user

Summarize:
- Which issue was addressed (ID, type, description)
- What you changed and why
- That tests pass and the issue is marked resolved
