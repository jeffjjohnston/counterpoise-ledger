# Common Patterns & Gotchas

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Transaction Balance Validation
Before inserting transactions, always validate:
```typescript
import { validateSplits } from "@/lib/accounting";
if (!validateSplits(splits)) {
  throw new Error("Transaction splits must sum to zero");
}
```

## Investment Shares Sign
Investment split `sharesMicros` should ALWAYS be positive. The `action` field determines direction:
- Buy: positive shares added to position
- Sell: positive shares subtracted from position (sign applied in calculation)

## Date Formatting
- Database stores dates as `YYYY-MM-DD` strings
- Use `toDateString()` from `lib/formatters.ts` to convert Date objects
- Use `formatDate()` for display formatting

## Payee Normalization
Payees are deduplicated using normalized names:
```typescript
import { normalizePayeeName } from "@/lib/payees";
const normalized = normalizePayeeName(input); // Trims, collapses whitespace runs, normalizes curly quotes to '
```

**It does not lowercase** — "IKEA" and "Ikea" are deliberately distinct
payees. The importer has its own copy, `normalizeName()` in
`scripts/import-moneydance/utils/format.ts`, which must stay behaviorally
identical or an import creates duplicates of payees the app already has.

## Modules Reachable From a Route or an MCP Tool Must Not Run Code at Import

Anything an API route or an `mcp/tools/*` module imports — directly or through
a chain — must contain **declarations only** at the top level. No CLI guard, no
`await`, no I/O.

The reason is the bundler, not the module system. `scripts/bundle-node-entrypoints.mjs`
esbuild-bundles `mcp/server.ts` into the single `/app/mcp-server.mjs` that the
Docker MCP client runs. Once a module is inlined there, `import.meta.url` is the
**bundle's** URL, so the standard main-module guard

```ts
const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
```

evaluates **true** under `node /app/mcp-server.mjs` and runs whatever it guards.

This shipped once. `lib/books.ts` imported `seedBook` from `db/seed.ts` for the
demo-book feature, which pulled `db/seed.ts`'s CLI guard into the bundle, where
it would have run `DROP SCHEMA public CASCADE` against the production database
on the first MCP connection after deploy. `db/seed.ts` is now declarations only
and its CLI lives in `db/seed-cli.ts`.

Every ordinary gate is blind to this: `npm run mcp:dev` is `npx tsx mcp/server.ts`,
where the imported module is separate and `argv[1]` is the server, so the guard
is false — and vitest, `tsc` and ESLint never build the artifact at all.
`tests/mcp/bundle-safety.test.ts` is the only check that does; it builds both
bundle targets with the real config and asserts the output carries no
`DROP SCHEMA` and no main-module guard. **Extracting code into `lib/` reads like
a pure refactor, which is exactly why nobody looks** — check a module's
top-level statements before making it reachable from a route or a tool.
