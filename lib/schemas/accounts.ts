import { z } from "zod/v4";

// Shape validation for the accounts resource. Business rules that require a
// database read (parentId must belong to this book, an account with
// transactions or sub-accounts cannot be deleted, an account must exist)
// stay in the route handlers — a schema cannot express them.

// Value lists mirror the `enum` options on `accounts.type`/`accounts.subtype`
// in db/schema.ts. Hoisted once and reused across all three schemas below so
// create/update/list can't drift out of sync with each other if the DB-level
// enum ever changes — only this file needs updating, not three call sites.
const accountTypeValues = ["asset", "liability", "equity", "income", "expense"] as const;
const accountSubtypeValues = ["bank", "credit_card", "loan", "investment", "cash", "other"] as const;

// Shared `z.enum` instances (not just the value arrays) so the ported
// "Invalid account subtype" message also lives in exactly one place.
const accountSubtypeSchema = z.enum(accountSubtypeValues, {
  error: "Invalid account subtype",
});

// One grapheme cluster, not one code unit: "👨‍👩‍👧‍👦" is eleven UTF-16 units and
// four code points but reads as a single character, and a length check on
// any of those would reject it. Intl.Segmenter is the only correct counter,
// and it is present in Node 18+ and every browser Next.js 16 targets.
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// An empty or whitespace-only string maps to null rather than failing: the
// picker clears its input to mean "go back to inheriting from the parent",
// and null is how that is stored.
export const accountIconSchema = z
  .union([z.string(), z.null()])
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  })
  .refine(
    (value) => value === null || [...graphemeSegmenter.segment(value)].length === 1,
    { error: "Icon must be a single character" }
  );

// The top-level `z.object(...)` also takes `{ error: "Name and type are
// required" }`. The original route's `const { name, type, ... } = body`
// auto-boxes a non-object body (`[]`, `"abc"`, `5`, `true`) without
// throwing, landing `name`/`type` as `undefined` and reporting this exact
// "required" message at 400 (only a literal `null` body threw, pre-schema).
// Without this override, zod's own object-shape check would reject those
// same inputs with its generic "Invalid input: expected object, ..." text
// instead. Same reasoning as lib/schemas/auth.ts's loginSchema.
export const createAccountSchema = z.object(
  {
    // The route's original guard was `if (!name || !type)`, which treats a
    // missing key and an empty string identically. `error` on z.string()
    // covers the "missing/wrong type" issue; `.min(1, ...)` covers "present
    // but empty" — both need the same message to reproduce that behavior.
    name: z.string({ error: "Name and type are required" }).min(1, "Name and type are required"),
    type: z.enum(accountTypeValues, {
      error: "Invalid account type",
    }),
    subtype: accountSubtypeSchema.nullish(),
    parentId: z.number().int().positive().nullish(),
    icon: accountIconSchema.optional(),
  },
  { error: "Name and type are required" }
);

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

// PUT /api/b/[bookId]/accounts/[id] never accepts `type` — an account's type
// cannot be changed after creation, so there is no `type` field here.
export const updateAccountSchema = z.object({
  name: z.string().optional(),
  subtype: accountSubtypeSchema.nullish(),
  parentId: z.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  icon: accountIconSchema.optional(),
});

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

// GET /api/b/[bookId]/accounts query params. `URLSearchParams.get()` returns
// `null` for an absent key, not `undefined` — callers must map `null` to
// `undefined` before calling `.safeParse()` (see the route), or an absent
// optional param would fail `.optional()`'s undefined-only check instead of
// being treated as "not provided".
//
// `includeInactive` stays a bare optional string, not `z.coerce.boolean()`:
// the route's existing semantics are "truthy only on the literal string
// 'true'" (anything else, including 'false' or '1', means false), and that
// check happens in the route after parsing — coercing here would change it.
export const listAccountsQuery = z.object({
  type: z.enum(accountTypeValues).optional(),
  includeInactive: z.string().optional(),
  asOfDate: z.iso.date().optional(),
});

export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;
