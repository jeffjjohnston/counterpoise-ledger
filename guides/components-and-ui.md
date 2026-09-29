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
- `/components/securities/` - Security management (SecurityForm, PriceHistoryEditForm, StockSplitEditForm, UpdatePricesModal)
- `/components/reports/` - Financial reports (ReportConfigPanel, ReportTable)
- `/components/sync/` - Plaid sync (ReconciliationModal)
- `/components/layout/` - Navigation (Navbar, BookNavbar, PriceEntryPill) and LastPostgresNotice, the dismissible notice on the book pages that names [upgrade-to-sqlite.md](upgrade-to-sqlite.md)
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
