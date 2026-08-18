---
name: verify
description: Build/launch/drive recipe for verifying Counterpoise UI changes end-to-end against the local dev server. Use when a code change needs runtime verification in the real app (not just tests).
---

> **Maintainer setup — adapt paths for your fork.** Container names are pinned
> by `name:` in `docker-compose.yml`, so those are the same in every checkout.

# Verifying Counterpoise changes at runtime

## Launch

When the **production Docker container** (`counterpoise-app-1`) is running locally, it holds port 3000 and serves deployed code — not your working tree. Always run the dev server on another port so the two can't be confused:

```bash
PORT=3001 npm run dev   # background it; ready when /login returns 200
```

The dev server uses the `counterpoise_dev` PostgreSQL database (Docker Compose must be up: `docker compose up -d`).

## Login

Seeded dev credentials: username `admin`, password `password` (created by `npm run db:seed`). Log in at `/login`, then navigate to `/b/1/transactions` (seed book id is 1, "Family Finances").

## Drive

- Playwright MCP tools (`mcp__plugin_playwright_playwright__browser_*`) work well; load via ToolSearch first.
- The transactions page redirects to a favorite account (`?accountId=N`) on load.
- Find target rows via `browser_evaluate` over `tbody tr`; right-click with `browser_click` + `button: "right"`; the row actions menu is `[role="menu"]` with `[role="menuitem"]` children. The ⋯ overflow button is `button[aria-label="Transaction actions"]`.
- Toasts auto-dismiss quickly — query for them within ~1s of the action (a `browser_evaluate` that clicks and then polls in the same call works).

## Data

Pick target rows by querying the dev DB directly:

```bash
PGPASSWORD=counterpoise psql -h localhost -U counterpoise -d counterpoise_dev
```

Dev data is disposable seed data, but restore any rows you mutate (UPDATE back to original values) so repeat runs stay deterministic. Note: `.env.production.local` credentials + database `counterpoise` (no `_dev`) is the **production** DB — don't mutate it during verification.

## Cleanup

Kill the dev server (`pkill -f "next dev"`), delete `.playwright-mcp/` and stray screenshots from the repo root before committing.
