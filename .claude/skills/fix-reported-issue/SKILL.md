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

## Work tracking

This project may use **beads** (`bd`) for issue tracking. Test for it once, before step 1:

```bash
command -v bd >/dev/null 2>&1 && bd ready
```

**If `bd` answers**, track the work in it:

| When | Do |
| --- | --- |
| After step 3, before you edit anything | `bd create --title="<short summary>" --type=bug --priority=2 --description="issue_reports #<id>, reported on <page>: <the user's own words>"`, then `bd update <bead-id> --claim` |
| Any time you find work you are **not** doing now | `bd create` it, with enough detail that nobody re-derives the investigation |
| With step 7 | `bd close <bead-id> --reason="<what changed>"`, then `bd dolt push` |

Three things about that table are load-bearing:

- **Quote the report in the description.** A future reader has no access to the production database, so a bead that says "fix the sync page" is a dead end. Paste what the user wrote.
- **`bd dolt push` is what makes the close durable.** Issue data lives in a local database; without the push it exists on one machine.
- **Filing discovered work is the point.** A reported issue routinely exposes an adjacent bug, a missing test, or a refactor. Step 4 tells you to keep the change minimal, and that instruction only holds if the work you are declining has somewhere to go. Widening the fix, or dropping the finding silently, are both failures of this step.

**If `bd` does not answer**, skip this section and change nothing else in the workflow. The issue_reports row is already the record of the fix; beads adds a home for the *discovered* work, which that row has no field for.

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

Stage only the files you changed and commit with a descriptive message. Reference the issue report ID in the commit body, and the bead ID too if you created one.

### 7. Mark the issue as resolved

```sql
UPDATE issue_reports SET status = 'resolved' WHERE id = <issue_id>;
```

Confirm the update succeeded (should show `UPDATE 1`). If you opened a bead, close it here too — see Work tracking above.

### 8. Report to the user

Summarize:
- Which issue was addressed (ID, type, description)
- What you changed and why
- That tests pass and the issue is marked resolved
