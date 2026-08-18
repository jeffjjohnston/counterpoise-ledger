import { z } from "zod/v4";

// Shape validation for GET /api/b/[bookId]/search's three query params
// (search/route.ts). No business rule stays behind in the route: the schema
// hands q/startDate/endDate straight to searchBook() (lib/search.ts), which
// itself treats a blank query as "no query" and returns empty buckets rather
// than a database read.

// `q` is read today as `url.searchParams.get("q")?.trim() ?? ""`
// (search/route.ts) — a null check, not a truthiness check: a missing key
// and an explicit `?q=` both end up "", but they get there differently (the
// former via `?? ""`, the latter by trimming a real empty string). The
// route's caller therefore maps this field with `?? undefined`, not `||`:
// an absent key becomes undefined and hits `.default("")` below; an explicit
// `?q=` stays a real `""` and reaches `.trim()` on its own, which is a no-op
// on an already-empty string. Either path lands on the same `""`, so the two
// operators are behaviorally interchangeable here — `??` is chosen because
// it mirrors the original literal read.
//
// searchBook() special-cases `q.trim() === ""` to return empty results
// before touching the database (lib/search.ts:75-78), so an empty `q` is
// not merely tolerated — it is the route's own documented behavior, exercised
// by tests/api/search.test.ts's "returns empty buckets for a blank query".
// This schema must not turn that into a 400.
//
// startDate/endDate are read today as
// `url.searchParams.get("startDate") || undefined` (search/route.ts) — a
// real truthiness check, not `??`. `""` has therefore always meant "absent"
// for these two params, same as a missing key. The caller maps both with
// `||`, not `??`: `??` would let a bare `?startDate=` reach the new
// `z.iso.date()` check below and turn a historically-silent no-op into a
// brand-new 400.
//
// Neither date param had a format check before this change — only the
// presence check above. Adding `z.iso.date()` is the same deliberate
// tightening `lib/schemas/reports.ts` and `lib/schemas/investments.ts`
// already made for their own date params: a malformed date filter has no
// sensible behavior to preserve, and a clean 400 is the established
// precedent for every date-range query param in this plan. This endpoint's
// only caller is app/b/[bookId]/search/page.tsx, which reads both values
// from a pair of native `<input type="date">` elements via
// components/ui/DateRangeFilter.tsx — those always emit `YYYY-MM-DD` or the
// empty string, never a malformed date, so the tightening cannot reject
// anything the app itself would ever send.
export const searchQuery = z.object({
  q: z.string().trim().default(""),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});

export type SearchQuery = z.infer<typeof searchQuery>;
