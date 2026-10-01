---
name: verify
description: Build/launch/drive recipe for verifying Counterpoise UI changes end-to-end against the local dev server. Use when a code change needs runtime verification in the real app (not just tests).
---

> **Maintainer setup — adapt paths for your fork.** Container names are pinned
> by `name:` in `docker-compose.yml`, so those are the same in every checkout.

# Verifying Counterpoise changes at runtime

## Launch

When the **production Docker container** (`counterpoise-rust-api-1`) is running locally, it holds host port 3000 and serves deployed code — not your working tree. Always run the dev servers on other ports so the two can't be confused. Run two processes, both in the background:

```bash
# 0. Once, with no server running on the file: the sample data
npm run db:seed

# 1. The Rust API server, on its own port
RUST_BIND=127.0.0.1:4100 \
  cargo run --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api   # ready when /health returns 200

# 2. The Vite dev server, which proxies /api to that Rust server
RUST_API_URL=http://127.0.0.1:4100 npm run dev -- --port 3001   # ready when /login returns 200
```

The Vite port is strict: if 3001 is in use, Vite stops with an error. Pick another port. The Rust server uses the SQLite file `data/counterpoise.db` in this checkout (set `DATABASE_PATH` for another file). It needs no Docker and no production environment file. Only one server can use a file: a second one stops with "another server uses ...". `npm run db:seed` also refuses while a server holds the file, so seed before you start the server. Rust code changes need a restart of the Rust server; client changes reload in the browser.

## Login

Seeded dev credentials: username `admin`, password `password` (created by `npm run db:seed`). Log in at `/login`, then navigate to `/b/1/transactions` (seed book id is 1; the household seed names it "Family Finances"). The seed dates end today. Add `-- --today YYYY-MM-DD` to `npm run db:seed` to pin them, and `-- --dataset single` for the single-homeowner dataset. A full single seed names its book "Demo Book - Single".

## Drive

- Playwright MCP tools (`mcp__plugin_playwright_playwright__browser_*`) work well; load via ToolSearch first.
- The transactions page redirects to a favorite account (`?accountId=N`) on load.
- Find target rows via `browser_evaluate` over `tbody tr`; right-click with `browser_click` + `button: "right"`; the row actions menu is `[role="menu"]` with `[role="menuitem"]` children. The ⋯ overflow button is `button[aria-label="Transaction actions"]`.
- Toasts auto-dismiss quickly — query for them within ~1s of the action (a `browser_evaluate` that clicks and then polls in the same call works).

## Data

Pick target rows by querying the dev DB directly:

```bash
sqlite3 data/counterpoise.db
```

The shell does not have the app's SQL functions (Unicode `lower()`, case-sensitive `LIKE`, `cp_today()`), so a text search there can differ from the app. Dev data is disposable seed data, but restore any rows you mutate (UPDATE back to original values) so repeat runs stay deterministic. The volume `counterpoise_data` holds the **production** database — don't open it during verification.

## Cleanup

Stop the two dev servers that you started (the `vite` process and the `counterpoise-rust-api` process; stop them by PID, not by a broad `pkill`, so that you do not stop another task's servers), delete `.playwright-mcp/` and stray screenshots from the repo root before committing.
