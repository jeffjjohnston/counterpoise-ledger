# Security Price Sync

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Security prices come from Tiingo's end-of-day API. Shared fetch logic lives in `/lib/tiingo.ts` (`fetchLatestTiingoPrices()`, `isTiingoConfigured()`); requires `TIINGO_API_KEY`.

- **Manual**: The Update Prices modal on `/securities` fetches latest prices via POST `/api/b/[bookId]/security-prices/tiingo`, then saves user-reviewed values via `/security-prices/bulk`
- **Cron**: GET `/api/cron/price-sync` fetches latest prices for all securities with `fetchPrices = true` across all books (Docker `scheduler` sidecar, Tue–Sat 6am ET — early morning after each market day). Requires `CRON_SECRET` bearer token; skips when `TIINGO_API_KEY` is unset
- The cron never overwrites an existing price for the same (security, date) — manual entries always win, and re-runs after market holidays are no-ops (Tiingo returns the prior market day's close, whose date is already recorded)
- Securities with `fetchPrices = false` (e.g. options, which have no Tiingo feed) are excluded and rely on manual price entry

## Fixed-Price Securities
A security with a non-null `fixedPriceMicros` is valued at that price forever — a money market fund at a $1.00 NAV. It is set on the Add/Edit Security form and cleared by unticking the same checkbox.

- **One rule, applied at the read sites.** `fixedPriceRow()` in `/lib/investments.ts` builds the synthetic price row, dated today so it wins every "newest price" comparison. `getLatestPrices()` uses it (covering `getPositions`, `getMarketValuesByAccount`, the securities list, the pill, and MCP's `get_security_detail`, which builds its position from `getPositions`), and the security detail route uses it directly — that route replays positions itself instead of calling `getPositions`, which is why it is the one place that needs its own call
- The fixed price **supersedes** any `securityPrices` rows, including ones recorded before the security was marked fixed-price. Those rows stay on the books as history and still render in the Price History tab; they no longer value the position
- **Setting a fixed price forces `fetchPrices = false`** in both `createSecurity()` and `updateSecurity()`, which the securities PUT route and `update_security` both call. Clearing the fixed price leaves fetching off — turning it back on is the user's call. The Tiingo cron and the Update Prices modal *also* filter on `fixedPriceMicros` rather than trusting that coupling
- The Update Prices modal renders a fixed-price security read-only ("Fixed at $1.00") with no Fetch checkbox, and the securities list marks its price cell `fixed`
- The investment entry form prefills Price from the fixed price when the user **picks** the security (`selectSecurity()` in `/components/transactions/useInvestmentEntry.ts`) and labels the field "Price (fixed)". The bare `setSelectedSecurityId()` setter deliberately does not prefill: `TransactionForm` uses it to restore a saved transaction, which must keep the price it was recorded at. The field stays editable
- Switching from a fixed-price security to an ordinary one clears the prefill, but **only if the field still holds exactly what was auto-filled** — a price the user typed survives a security change, as it does everywhere else in that form
- Ticking Fixed price with no usable amount blocks submission rather than sending `null`, which would read as "not fixed" while the box still shows ticked. Unticking the box is the only way to clear a fixed price
- Prices are written into form fields by `formatPriceMicrosInput()` in `/lib/formatters.ts` — at least cents, never rounded to them. That text is what the form sends back on the next save, so rounding a NAV like 1.0025 there would silently rewrite the security's value

## Quick Price Entry Pill
Manually-priced securities are prompted for via a navbar pill (`/components/layout/PriceEntryPill.tsx`), visible on every book page:
- GET `/api/b/[bookId]/securities/prices-due` returns securities with `fetchPrices = false`, no fixed price, an open position (via `getPositions()`), and no price for the due date
- The due date is the newest price date across `fetchPrices = true` securities (the cron keeps these current, so this tracks the last market day through holidays); falls back to the last calendar weekday when the book has no fetchable prices
- The pill (`● N prices due`) opens a popover form: one row per security (symbol, input prefilled with the last saved mark), first field focused with value selected, Enter saves all via `/security-prices/bulk`, Escape closes
- Pressing `P` opens the popover from any book page; there is no dismissal — the pill is quiet until prices are entered
- After a save the pill dispatches a `counterpoise:security-prices-saved` window event (exported as `PRICES_SAVED_EVENT`); the transactions page listens and refreshes so the positions table picks up new market values
- Lists derive from open positions, so rolled/expired options drop off without configuration
