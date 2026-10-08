# Component Development

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## UI Component Library
Located in `/components/ui/`:
- `Button.tsx`, `Input.tsx`, `Select.tsx`, `Tabs.tsx` - Form controls
- `Modal.tsx` - Dialog container
- `Card.tsx` - Card layout
- `Toast.tsx` - Notification toasts
- `DateRangeFilter.tsx` - Date range filtering
- `DateInput.tsx` - Date input field
- `Skeleton.tsx` - Loading skeleton placeholders
- `EmptyState.tsx` - Empty state displays
- `ThemeToggle.tsx` - Dark/light theme toggle
- `Textarea.tsx` - Multi-line text input
- `AccountAutocomplete.tsx` - Account selection with type-ahead search
- `PayeeAutocomplete.tsx` - Payee selection with search
- `SecurityAutocomplete.tsx` - Security selection with search
- `CategoryIcon.tsx` - Renders a resolved category icon in a fixed-width box; the only component that knows an icon is an emoji

## Feature Components
Organized by domain:
- `/components/accounts/` - Account management (AccountList, AccountForm, AccountCard, PositionsTable, IconPicker)
- `/components/transactions/` - Transaction forms and lists (TransactionForm, TransactionList, SplitEditor, InvestmentPositionsSection, NoteIndicator)
- `/components/securities/` - Security management (SecurityForm, PriceHistoryEditForm, StockSplitEditForm, UpdatePricesModal, AllocationChart)
- `/components/reports/` - Financial reports (ReportConfigPanel, ReportTable, ReportChart, RealizedGainsChart)
- `/components/charts/` - Chart components (see [Charts](#charts))
- `/components/dashboard/` - Dashboard cards (NetWorthCard)
- `/components/sync/` - Plaid sync (ReconciliationModal)
- `/components/layout/` - Navigation (Navbar, BookNavbar, PriceEntryPill)
- `/components/ThemeProvider.tsx` - Root theme provider
- `/components/KeyboardShortcutProvider.tsx` + `/components/ui/KeyboardShortcutOverlay.tsx` - Global keyboard shortcut system. Register shortcuts in client components via `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts`; press `?` to view the overlay.
  - A shortcut's `category` is typed from `SHORTCUT_CATEGORIES` in the provider, which is also the order the overlay lists categories in. **One list, on purpose.** The overlay used to keep a second ordering array and *filter* through it, so a category registered but not listed there lost its shortcuts with no error — the price entry pill's `P` never appeared in the overlay for that reason. Adding a category means adding it to `SHORTCUT_CATEGORIES`; nothing else compiles until you do.
- `/components/ReportIssueModal.tsx` - In-app issue reporting (writes to the `issue_reports` table, which is read when triaging reports)
- `/components/transactions/PlaidBanner.tsx` - Banner shown on transactions linked to a Plaid reconciliation row

## Pages and routing
- Every page and component runs in the browser. No page renders on the server. Vite builds the client, and the Rust server serves it as static files (see [architecture.md](architecture.md))
- Some files still start with `"use client"`. Vite ignores the directive
- Pages fetch their data in the browser through `/lib/api-client.ts`
- To add a page, put it in `app/` at its URL path and add its route to `client/routes.tsx`
- Import `Link` and the router hooks from `/lib/navigation.tsx`, never from `react-router`. ESLint refuses that import outside `client/**` and the two layout routes
- Use `useBookId()` from `/hooks/useBookId.ts` for current book ID; `useIsMobile()` from `/hooks/useIsMobile.ts` for responsive logic; `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts` for keyboard shortcut registration

## Shared calculations in the browser

Client components import `lib/wasm-client.ts` for accounting, account-tree,
recurrence, expression, and formatting calculations. It preserves the previous
TypeScript call signatures while calling the `ledger-core` WebAssembly build.
Account names and descendant IDs are calculated in one WASM call per account
list, then read from memoized maps in render loops. Settled transaction dates
return directly from their stored value; floating dates send only their date
and floating flag to WASM. Currency and investment values that cannot be
represented by Rust `i64` use the pure TypeScript format or arithmetic helper,
so editing an amount never throws during render.
The WASM binary is encoded in the client chunk and instantiated synchronously
when the module loads, before the first component renders. Amount fields can
therefore validate each keystroke without waiting for a network request. The
Rust server links the same `ledger-core` crate, so the browser and the API
calculate with one implementation.

Bundle measurement on 2026-09-25, with the Next build of that date: summing
the uncompressed `.js` files under `.next/static/chunks` after `npm run build` gave 1,696,161 bytes before the
WASM adapter, 3,865,616 bytes in the first WASM build, and 3,563,510 bytes
after the release profile and `wasm-opt` changes. The optimized build is
1,867,349 bytes above the TypeScript-only baseline and 302,106 bytes below
the first WASM build. This is the sum of all generated chunks, not the
transfer size of one page. The inline WASM accounts for most of the increase.

- 2026-10-02, charts wave 1: the shared chart chunk, `useChartSize`, is
  20,637 bytes (gzip 8,436). Only the dashboard and the custom report chunks
  load it. The dashboard chunk also grows by its own d3 code (the time scale,
  the line and the bisector) and its chart code: from 5,995 to 28,180 bytes.
  The custom report chunk grew from 12,639 to 21,735 bytes. The entry chunk is
  650,903 bytes, 91 bytes more than the 650,812 bytes before.
- 2026-10-07, charts wave 2: sizes are raw bytes and gzip (`gzip -9`) of the
  files in `build/assets` after `npm run build`. "Before" is `dev` at the
  branch point of the wave, built in a clean worktree. The page chunks:

  | Chunk | Before | After |
  | --- | --- | --- |
  | Dashboard | 28,831 (gzip 9,491) | 15,576 (gzip 5,296) |
  | Security detail | 24,693 (gzip 5,311) | 26,468 (gzip 5,992) |
  | Payee detail | 5,216 (gzip 1,929) | 7,084 (gzip 2,604) |
  | Income statement | 6,632 (gzip 2,354) | 11,179 (gzip 3,895) |
  | Transactions | 36,834 (gzip 10,675) | 39,047 (gzip 11,413) |

  The dashboard chunk is smaller because its chart code moved into shared
  chunks. `ChartCard` grew from 6,462 (gzip 2,815) to 22,725 (gzip 9,159)
  bytes: it now holds `useChartSize` and the d3 code that the pages share.
  Two chunks are new: `BarChart` (5,789; gzip 2,530) and `RangeGroup`
  (20,878; gzip 7,316). The entry chunk is 653,248 bytes (gzip 208,732), 112
  bytes more than the 653,136 bytes before. The sum of all `.js` files is
  3,224,681 bytes, 19,396 bytes more than the 3,205,285 bytes before.

## Charts

The chart components are in `components/charts/`: `BarChart` (vertical or
horizontal, stacked segments, negative values below the zero line),
`LineChart`, `AreaChart`, `ChartTooltip`, `ChartLegend`, `ChartCard`, `Axis`, `useChartSize` and
`useDismissOutside` (closes a tooltip on a tap outside the chart or on Escape). They
use d3-scale, d3-shape and d3-array for the math, and React for the SVG.

- Every chart goes in a `ChartCard`, also a chart with no table under it. The
  card has the "Hide chart" button and keeps the choice for each viewer in
  `localStorage`, under the key that the chart gives
  (`counterpoise.<name>Chart.hidden`). The page works when the storage is
  blocked. `title` is the heading (default "Chart"). Each chart gives its own
  title, for example "Allocation", "Gains by month" and "Report". `actions` is
  a node, such as the range group of `NetWorthCard`, that shows before the
  button while the chart is shown. On a narrow screen, the actions go to a
  second line under the title. If they are still too wide, the groups wrap
  onto more lines. Each group and the button keep their labels whole
  (`whitespace-nowrap` on each, not on the row), so a header of three
  controls does not make the page scroll sideways at 320 px. Put the data fetch in a child of the card: a hidden chart
  then sends no request. A repository test fails when a file in `app/` or
  `components/` renders `<BarChart`, `<LineChart` or `<AreaChart` and does not
  render `<ChartCard`.
- `AreaChart` draws stacked areas over time, with d3-shape `stack` and
  `stackOffsetDiverging`: positive series stack up from zero, negative
  series stack down. All series have the same dates. The optional `total`
  series is a 2 px line on top. The tooltip shows each series and the total
  (the sum of the series when there is no `total`). `totalLabel` names the
  total row of the tooltip (default "Total"). `NetWorthCard` passes "Net
  worth", as the legend and the table say. `DateAxis` and `toDate()`
  in `Axis.tsx` are the date labels that `LineChart` and `AreaChart` share.
- `NetWorthCard` (`components/dashboard/`) has a "Total / By group" view
  group before the range group. "Total" is the net worth line. "By group"
  reads `net-worth-history?groupBy=account` and draws an `AreaChart` of the
  top-level asset and liability accounts, shaped by
  `toNetWorthGroupChart()`, with a `ChartLegend` and net worth as the total
  line. The view is component state only. It is not stored. The `sr-only`
  table of "By group" has one column for each shown group. It is in an
  `sr-only` div: a table does not get narrower than its columns, so a wide
  table with only `sr-only` makes the page scroll sideways on a phone.
- Put each `sr-only` chart table in an `sr-only` div (`<div className="sr-only">
  <table>...`). A table does not get narrower than its columns, so a wide
  table with only `sr-only` on the table makes the page scroll sideways on a
  phone. All chart tables follow this rule.
- `RangeGroup` (`components/charts/RangeGroup.tsx`) is the 1Y / 5Y / All
  button group for `actions`. `rangeStart()` in `lib/chart-range.ts` gives the
  first date of a range. `PriceHistoryChart` (`components/securities/`) is the
  price line on the security page. It reads `prices?limit=5000&startDate=...`,
  apart from the price table, and it fetches again when the page changes a
  price. A security with a fixed price has no price history, so the page
  shows no chart card for it. The price table is the visible table, so this
  chart has no `sr-only` table.
- `PayeeSpendingChart` (`components/payees/`) is the "By month" card on the
  payee page. It reads `reports/data?payeeId=...&accountTypes=income,expense`
  for the last 12 months (local dates, from the first day of the month 11
  months back). `toPayeeSpendingChart()` shapes the rows with `groupSplits()`
  and `toChartData()` with `["month"]`, as the report chart does, and adds a
  zero group for each empty month, so that a payee that is paid each quarter
  does not look monthly. `ReportBars` (exported from `ReportChart.tsx`) draws
  them, 160 / 200 high. The page gives a `refreshKey`, which it increases
  after a save or a delete of a transaction, and the chart fetches again. Each
  fetch takes one date snapshot for the request dates and for the months of
  the bars, and keeps them with the response, so a refresh after a month
  boundary moves the window. The
  transaction list shows no monthly totals, so the chart has an `sr-only`
  table of month, type and amount.
- `IncomeStatementCharts` (`components/reports/`) puts two cards on the
  income statement page, between the summary cards and the account cards.
  "Income and expense" reads `reports/data?accountTypes=income,expense`
  with the page period (no dates for "All time"). The page passes
  `activeAccountIds`, and the chart drops the splits of other accounts, because
  the route returns inactive accounts too and the page totals do not, so the
  monthly totals add up to the summary cards. It draws Income, Expense
  and Net as three bars for each month, because `BarChart` has no line
  overlay. Months without splits get zero bars. When the range has more than
  24 months (`MAX_MONTHS`, the rule of the realized gains chart), each group
  is one year, so that the bars stay wide enough on a phone. A range with fewer than 2
  months removes the card, and a hidden card sends no request, so the card
  stays with its "Show chart" button. It has an `sr-only` table. Its height
  (and the height of its loading placeholder) is 160 / 200, set with the `verticalHeight` prop of `ReportBars`. "Expense by
  category" uses the expense balances that the page already has, rolled up to
  the top-level account. Each balance is the own balance of one account (the
  `income-statement` route and `GET /accounts` do not add children to a
  parent), so the roll-up adds each row once. The account cards are its
  visible table.
- `AccountBalanceChart` (`components/transactions/`) is the "Balance" card in
  the register, between the positions section and the transaction list. The
  page shows it only when one account is selected and that account is not an
  investment account. The positions section shows an investment account, and
  a line of its cash only would mislead. It reads
  `accounts/[id]/balance-history?startDate=...&endDate=<local today>` and
  draws the points with `toAccountBalanceChart()`. A new account, a new range
  or a new `refreshKey` (the page gives `positionsVersion + reconcileVersion`:
  the first changes after each data load, and the second after a reconcile
  toggle, which can move the date of a floating transaction) fetches again. Its height is 120 / 160, lower than
  the other charts, because the register needs its vertical space. The
  register shows a running balance only at each transaction, so the chart
  has an `sr-only` table of date and balance.

- The data of a chart comes from a pure function in `lib/` (for example
  `lib/report-chart.ts`, `lib/realized-gains-chart.ts`,
  `lib/allocation-chart.ts`). The component only draws it. Test the function.
- A horizontal chart is `BAR_ROW_HEIGHT` (from `BarChart.tsx`) times its bars,
  plus 32, high. A ranked chart shows the 10 largest items and puts the rest
  into "Other".
- A bar segment can have a `detail`, such as a share of the total. The
  tooltip shows it next to the value. Keep the series label short, because the
  detail takes space from it.

- Colors come from `--chart-1` to `--chart-8` in `app/globals.css`, with a
  light and a dark value. `--chart-8` is for "Other". Do not put a
  hard-coded color in a chart: the SVG uses `var(--chart-n)`, so a theme
  change needs no re-render. `tests/lib/chart-palette.test.ts` checks a
  contrast of 3:1 or more against `--bg-primary`.
- Axis labels use `formatCurrencyCompact`. Tooltips use `formatCurrency`.
  `valueTicks()` in `components/charts/Axis.tsx` drops a tick that is not a
  whole number of cents. When two short labels are the same, it gives each
  label the decimals that the tick step needs (`compactDecimals()`), for
  example "$1.00005M" or "$0.5". A left value axis makes the left margin
  wider when the longest label needs more than the default
  (`tickLabelWidth()`). A bottom value axis shows every nth label, so that
  two labels do not overlap.
- A chart has `role="img"` and an `aria-label` with the range and the
  totals. The table under the chart is the accessible form of the data.
- Only the pages that draw a chart import d3, so it is not in the entry
  chunk. Do not import `components/charts/` from a shared module.
- A test of a chart calls `stubResizeObserver()` from
  `tests/helpers/resize-observer.ts`, because jsdom has no
  `ResizeObserver`.

## The Mobile/Desktop Breakpoint Is In Two Places

The layout switch is **`lg` (1024px)**, and it is declared twice: as Tailwind
`lg:` classes in `BookNavbar.tsx`, `transactions/page.tsx` and
`accounts/page.tsx`, and as `MOBILE_BREAKPOINT` in `/hooks/useIsMobile.ts`.
**The two must move together.** The CSS controls the navbar, sidebar, drawer and
FAB; the hook is what `TransactionList.tsx` reads to render the card list
instead of the register table. Change one alone and you get a half-switched
layout — the sidebar hides while the crushed table stays.

It is `lg`, not `md`, because the desktop navbar needs ~1019px. At `md` (768px)
every portrait iPad rendered a navbar it could not fit, which pushed More,
Search, Report an issue and the user menu off-screen entirely, and scrolled the
whole document sideways. The book-name button is capped (`sm:max-w-[10rem]`) so
that width stays bounded no matter how long a book is named.

Two register tables are `table-fixed` with a `<colgroup>` mixing `rem` and `%`
widths. Fixed widths are satisfied first, so when they exceed the container the
percentage column collapses to **0px** and its text paints over its neighbour —
this is how the Activity column disappeared. Keep the fixed columns under 36rem. No test asserts this budget, so check the
register at 1024px after you change a column width.

## Live refresh subscriptions

Use `useBookChanges` from `components/BookChangesProvider.tsx` within the book
layout. Subscribers receive table invalidations or a reset, never row contents.
The provider owns the EventSource; adding a subscriber does not open another
connection. It closes on book navigation, unmount, and successful navbar logout.

The transaction data hook serializes refreshes and retains a pending refresh
when another event arrives during a request. Automatic refreshes preserve the
loaded register extent and do not scroll to the top. They include projected and
pending Plaid rows and defer while edit/mobile-create modals are open. Responses
from obsolete book/filter scopes are discarded. Explicit local refreshes may run
inside editors (for example, after creating an account) and retain the existing
scroll behavior. No unsaved form state is replaced by live updates.

Local write refreshes and automatic invalidations share a fixed 400 ms scheduling
window, covering the usual server/browser notification delay without resetting
the timer on every event. Initial loads and filter changes run immediately.
Explicit refreshes still run when SSE is disconnected and retain their ensureId
and scroll behavior. Hints received after a fetch starts always queue a trailing
fetch; a late self-echo can therefore cause a second fetch. With hint-only events,
ignoring that echo could also discard an unrelated external write.

Market values, payees, projected rows and pending Plaid rows degrade independently
to empty lists if their requests fail. Only account/transaction request failures
block the register. The initial-load error flag is consumed by an active scope's
completion, so Strict Mode's aborted setup cannot turn an initial error into a
background toast.
