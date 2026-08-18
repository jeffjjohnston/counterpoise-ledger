import { z } from "zod/v4";

// Shape validation for the auth routes (app/api/auth/**). Several guards in
// these routes are business rules, not shape, and stay in the route
// handlers untouched:
//   - login: "Invalid username or password" (401) — the same message for an
//     unknown username and a wrong password, verified via a DB read and a
//     scrypt hash comparison (a dummy hash is verified against for a
//     nonexistent user, to keep timing uniform so the message doesn't leak
//     which case occurred). This schema layer must not disturb that.
//   - login/register/password: rate limiting (429) — lib/rate-limit.ts,
//     keyed on request/session state, not the body's shape.
//   - register: "Registration is closed" (403) — reads isRegistrationOpen()
//     (a DB/config read). See registerSchema's own comment below for how
//     this interacts with shape-validation ordering.
//   - register: "Username already taken" (409) — a DB read inside the
//     registration transaction.
//   - password: "Current password is incorrect" (401) — verifies a hash;
//     the task brief's own example of a guard that must stay.
//   - password/me: "User not found" / "Not authenticated" (401) — a session
//     check or a session referencing a userId no longer in the database.
//
// "Invalid key ID" (api-keys/[id]/route.ts DELETE, from parseInt on the :id
// path segment) is left untouched — the same precedent lib/schemas/accounts.ts
// and lib/schemas/sync.ts establish for path-segment ids not being this
// schema layer's job ("Invalid book ID" gets the identical treatment in
// lib/schemas/books.ts).

// ---------------------------------------------------------------------------
// loginSchema — POST /api/auth/login
// ---------------------------------------------------------------------------
//
// The route's two guards run back-to-back with nothing business-rule shaped
// between them, so both fold into one schema, parsed as the very first step
// in the route (before rate limiting) — the same position the guards held
// before. That ordering is load-bearing, not cosmetic: checkRateLimit()
// lowercases the username to build its key, so a non-string username
// reaching it throws and the route would 500 instead of 400 — this schema
// guarantees both fields are strings before the route ever gets there.
//
// Fields are `z.unknown()`, not `z.string()`: the two guards need two
// different messages depending on *why* a field is invalid — absent/falsy
// (`!username`) vs. present-but-wrong-type (`typeof !== "string"`) — and a
// single `z.string({ error })` can only report one message for both failure
// modes (see lib/schemas/accounts.ts's `name` field, which deliberately
// collapses "missing" and "empty" into ONE message because the original
// guard did too — this is the opposite case, two guards with two distinct
// messages). superRefine reproduces the original's exact two-step sequence:
// each branch returns after adding its issue, so at most one issue is ever
// added per parse, matching the original's early-return control flow
// (`if (...) return ...; if (...) return ...;`) exactly.
//
// The top-level `z.object(...)` also takes `{ error: CREDENTIALS_REQUIRED_MESSAGE }`.
// Without it, a non-object root (a JSON body of `[]`, `"abc"`, `5`, `true`,
// or `null`) fails zod's own object-shape check before superRefine ever
// runs, surfacing zod's generic "Invalid input: expected object, ..." text
// instead of the ported message. The original route's plain destructuring
// (`const { username, password } = await request.json()`) auto-boxes a
// string/number/array/boolean without throwing — `username`/`password` come
// out `undefined`, falling through to this exact "required" guard at 400 —
// so `[]`/`"abc"`/`5`/`true` all had a ported message to preserve, same as
// a body simply missing the keys. Only a literal `null` body threw before
// (destructuring `{ username, password }` from `null` is a TypeError), so
// this also upgrades that one case from an uncaught 500 to a correct 400.
// Matches the precedent lib/schemas/sync.ts's `reconcileSchema` sets, and
// verified directly (not assumed) that this doesn't clobber
// `CREDENTIALS_STRING_MESSAGE` once the input is a genuine object — see
// tests/lib/schemas/auth.test.ts.
const CREDENTIALS_REQUIRED_MESSAGE = "Username and password are required"; // login/route.ts:32
const CREDENTIALS_STRING_MESSAGE = "Username and password must be strings"; // login/route.ts:41

export const loginSchema = z
  .object(
    {
      username: z.unknown(),
      password: z.unknown(),
    },
    { error: CREDENTIALS_REQUIRED_MESSAGE }
  )
  .superRefine((data, ctx) => {
    if (!data.username || !data.password) {
      ctx.addIssue({ code: "custom", message: CREDENTIALS_REQUIRED_MESSAGE, path: ["username"] });
      return;
    }
    if (typeof data.username !== "string" || typeof data.password !== "string") {
      ctx.addIssue({ code: "custom", message: CREDENTIALS_STRING_MESSAGE, path: ["username"] });
    }
  });

// The route casts `parsed.data` to this after a successful parse — the
// superRefine above guarantees both fields are non-empty strings by the time
// safeParse succeeds, a guarantee zod's own inferred type (unknown/unknown)
// can't express on its own. Matches the precedent in lib/schemas/sync.ts's
// `SyncResolveActionPayload` cast for `reconcileSchema`.
export interface LoginInput {
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// registerSchema — POST /api/auth/register
// ---------------------------------------------------------------------------
//
// The original guard order interleaves a business-rule check between two
// groups of shape checks:
//   1. `!username || !password`                                 (400, shape)
//   2. `!(await isRegistrationOpen())`              (403, business rule — DB)
//   3. `typeof username !== "string" || username.length < 3`    (400, shape)
//   4. `typeof password !== "string" || password.length < 8`    (400, shape)
//
// This schema combines 1/3/4 into one object, parsed as the route's very
// first step — matching every other already-migrated route in this plan
// (one schema.safeParse() call per route, up front), and matching guard 1's
// original position exactly.
//
// The one behavior change: guards 3 and 4 used to run *after* the
// registration-open gate, so a request with e.g. a too-short username sent
// while registration is closed used to get 403 ("Registration is closed")
// without ever reaching the length check. It now gets 400 ("Username must
// be at least 3 characters") instead, since all shape validation now runs
// before the gate. This does not create a new oracle: the 403 gate is
// global, not keyed on username or any per-account state, so a caller
// learns nothing about a specific account from this reordering — only that
// shape validation happens first, true of every other route this plan
// touches. Flagged explicitly in the task report rather than treated as
// self-evidently fine, per the task's instruction to report (not decide)
// any case where an unauthenticated caller's observable behavior changes.
const USERNAME_LENGTH_MESSAGE = "Username must be at least 3 characters"; // register/route.ts:32
const PASSWORD_LENGTH_MESSAGE = "Password must be at least 8 characters"; // register/route.ts:39

// Same non-object-root reasoning as loginSchema above: `{ error:
// CREDENTIALS_REQUIRED_MESSAGE }` on the top-level object reproduces the
// original's "required" message for `[]`/`"abc"`/`5`/`true`/`null`, all of
// which reached this exact guard (via auto-boxing or, for `null` alone, a
// pre-schema throw) before this task.
export const registerSchema = z
  .object(
    {
      username: z.unknown(),
      password: z.unknown(),
    },
    { error: CREDENTIALS_REQUIRED_MESSAGE }
  )
  .superRefine((data, ctx) => {
    if (!data.username || !data.password) {
      ctx.addIssue({ code: "custom", message: CREDENTIALS_REQUIRED_MESSAGE, path: ["username"] });
      return;
    }
    if (typeof data.username !== "string" || data.username.length < 3) {
      ctx.addIssue({ code: "custom", message: USERNAME_LENGTH_MESSAGE, path: ["username"] });
      return;
    }
    if (typeof data.password !== "string" || data.password.length < 8) {
      ctx.addIssue({ code: "custom", message: PASSWORD_LENGTH_MESSAGE, path: ["password"] });
    }
  });

export interface RegisterInput {
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// changePasswordSchema — PUT /api/auth/password
// ---------------------------------------------------------------------------
//
// All four of the route's 400 guards run back-to-back before anything else
// in the route (including the session check), so all four fold into one
// schema, matching their original relative order and position exactly.
//
// Password policy found here: newPassword must be at least 8 characters —
// ported verbatim below, and there is no other length or complexity rule to
// port (no maximum length, no character-class requirement). Not changed in
// either direction.
//
// "New password must be different from current password" is a pure
// comparison of two body fields — no DB or hash read — so it is shape, not
// a business rule, and becomes part of this schema too. It is NOT the
// "Current password is incorrect" guard the task brief calls out by name as
// a business rule that must stay; that one verifies a hash against the
// database and remains in the route, at 401, untouched.
const PASSWORD_REQUIRED_MESSAGE = "Current password and new password are required"; // password/route.ts:20
const PASSWORD_TYPE_MESSAGE = "Invalid password payload"; // password/route.ts:27
const NEW_PASSWORD_LENGTH_MESSAGE = "New password must be at least 8 characters"; // password/route.ts:34
const PASSWORD_SAME_MESSAGE = "New password must be different from current password"; // password/route.ts:41

// Same non-object-root reasoning as loginSchema above: `{ error:
// PASSWORD_REQUIRED_MESSAGE }` reproduces the original's "required" message
// for a non-object body instead of zod's generic type-check text.
export const changePasswordSchema = z
  .object(
    {
      currentPassword: z.unknown(),
      newPassword: z.unknown(),
    },
    { error: PASSWORD_REQUIRED_MESSAGE }
  )
  .superRefine((data, ctx) => {
    if (!data.currentPassword || !data.newPassword) {
      ctx.addIssue({ code: "custom", message: PASSWORD_REQUIRED_MESSAGE, path: ["currentPassword"] });
      return;
    }
    if (typeof data.currentPassword !== "string" || typeof data.newPassword !== "string") {
      ctx.addIssue({ code: "custom", message: PASSWORD_TYPE_MESSAGE, path: ["currentPassword"] });
      return;
    }
    if (data.newPassword.length < 8) {
      ctx.addIssue({ code: "custom", message: NEW_PASSWORD_LENGTH_MESSAGE, path: ["newPassword"] });
      return;
    }
    if (data.currentPassword === data.newPassword) {
      ctx.addIssue({ code: "custom", message: PASSWORD_SAME_MESSAGE, path: ["newPassword"] });
    }
  });

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

// ---------------------------------------------------------------------------
// createApiKeySchema — POST /api/auth/api-keys
// ---------------------------------------------------------------------------
//
// Same combined-message idiom as lib/schemas/sync.ts's `createTokenSchema`:
// `.trim()` reproduces the route's own `name.trim()` normalization (so
// `parsed.data.name` already carries the value the route inserts), and
// `.min(1, ...)` after `.trim()` reproduces `!name.trim()` — a
// whitespace-only name is rejected the same as an empty or missing one.
const API_KEY_NAME_MESSAGE = "Name is required"; // api-keys/route.ts:41

// Same non-object-root reasoning as loginSchema above: the original route's
// `const { name } = body` auto-boxes a non-object body without throwing
// (only a literal `null` threw), landing on this exact message at 400 —
// `{ error: API_KEY_NAME_MESSAGE }` on the top-level object reproduces that
// for `[]`/`"abc"`/`5`/`true`/`null` alike.
export const createApiKeySchema = z.object(
  {
    name: z.string({ error: API_KEY_NAME_MESSAGE }).trim().min(1, API_KEY_NAME_MESSAGE),
  },
  { error: API_KEY_NAME_MESSAGE }
);

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
