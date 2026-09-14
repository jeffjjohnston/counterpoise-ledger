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
- `/components/layout/` - Navigation (Navbar, BookNavbar, PriceEntryPill)
- `/components/ThemeProvider.tsx` - Root theme provider
- `/components/KeyboardShortcutProvider.tsx` + `/components/ui/KeyboardShortcutOverlay.tsx` - Global keyboard shortcut system. Register shortcuts in client components via `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts`; press `?` to view the overlay.
  - A shortcut's `category` is typed from `SHORTCUT_CATEGORIES` in the provider, which is also the order the overlay lists categories in. **One list, on purpose.** The overlay used to keep a second ordering array and *filter* through it, so a category registered but not listed there lost its shortcuts with no error — the price entry pill's `P` never appeared in the overlay for that reason. Adding a category means adding it to `SHORTCUT_CATEGORIES`; nothing else compiles until you do.
- `/components/ReportIssueModal.tsx` - In-app issue reporting (writes to the `issue_reports` table, which is read when triaging reports)
- `/components/transactions/PlaidBanner.tsx` - Banner shown on transactions linked to a Plaid reconciliation row

## Client vs Server Components
- Pages are Server Components by default
- Use `"use client"` for interactive components
- API data fetching happens in Server Components or via client fetch
- Use `useBookId()` from `/hooks/useBookId.ts` for current book ID; `useIsMobile()` from `/hooks/useIsMobile.ts` for responsive logic; `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts` for keyboard shortcut registration

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
this is how the Activity column disappeared. Keep the fixed columns under 36rem;
`TransactionList.test.tsx` asserts that budget.
