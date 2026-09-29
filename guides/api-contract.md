# API Contract

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## What it is

`openapi/openapi.json` describes the routes a native client uses. The Rust
server writes it. Do not edit it by hand.

The source is `rust-api/server/src/openapi/`:

- `schemas.rs` — the component schemas, in document order. The name of each
  is the name of the type a client generates. `dsl.rs` gives the small
  vocabulary they are written in (`object`, `nullable`, `reference`,
  `.describe()`, ...), over utoipa's schema model. It writes the exact JSON
  Schema shape of the contract: no `format` on an integer, `anyOf` with
  `null` for a nullable field, and a required nullable field where the
  contract has one. The utoipa derive macros write other shapes, and a
  client's generated types follow the shape.
- `operations.rs` — the list of routes in the contract. Every path
  placeholder is a required integer path parameter. An error status that a
  client must handle as a different case goes in the operation's `errors`
  list. An example is the 409 on transaction `PUT` and `DELETE`. A unit test
  fails when an operation is not a route in `rust-api/routes.json`.
- `mod.rs` — builds the OpenAPI 3.1 document, and the `openapi` command.
- `lib/api-contract.ts` — `API_CONTRACT`, the number a client compares. The
  Rust server reads it at build time, with the package version.

`GET /api/version` is public and returns the package version and
`API_CONTRACT`.

## Commands

- `npm run openapi:generate` — write `openapi/openapi.json`
  (`counterpoise-rust-api openapi`). The release script runs it after the
  version bump.
- `npm run openapi:check` — fail when the file is stale. CI runs this in the
  Rust job, and `cargo test` checks it too.

## Rules

1. A pull request that adds or changes a route a native client uses registers
   it in `rust-api/server/src/openapi/operations.rs` and regenerates the file.
   CI enforces the regeneration.
2. Adding an optional field is additive. `API_CONTRACT` stays the same.
   Recent examples: the book response's optional `role`, and the transaction
   response's optional `createdBy`/`updatedBy`. The four book-member routes
   (`GET`/`POST /api/books/{bookId}/members`,
   `PUT`/`DELETE /api/books/{bookId}/members/{userId}`) were added the same
   way — new routes, registered in the operation list, do not bump
   the contract either.
3. Adding a value to an enum is a breaking change. A generated client decodes
   an enum as a closed set, so an unknown value fails the decode. Increase
   `API_CONTRACT`. The enums in the contract today are `AccountType`,
   `AccountSubtype`, `SecurityRow.securityType`, and
   `InvestmentSplitRow.action`.
4. Removing or renaming a field, changing a type, or removing a route is a
   breaking change. Increase `API_CONTRACT` and add a line to its history
   comment.
5. Response schemas are strict in the tests. The HTTP suite under
   `tests/http/` checks each response body against its component schema in
   `openapi/openapi.json`, through `contract()` in `tests/helpers/contract.ts`.
   That helper adds `additionalProperties: false` to every object, so an
   undeclared field fails the test. Fix the schema, not the handler.
6. The generated document strips `additionalProperties`, so a client accepts
   fields it does not know. That is what makes rule 2 safe.
7. When `API_CONTRACT` changes, the release notes name the minimum client
   version. See guides/release-and-deploy.md.
8. When practical, keep the previous fields for one minor release after a
   breaking change, so an installed client has a window to update.

## Auth in the contract

Data routes accept a cookie session or `Authorization: Bearer cpk_...`.
Credential routes (password change, API key list, mint, and revoke) accept
the cookie only, through `cookie_session()` in
`rust-api/server/src/routes/auth.rs`. A device that holds one key must not be
able to mint another.

A failed bearer attempt counts in the `ApiKey` rate-limit scope against the
pair of client IP and key prefix, not the IP alone. A device that keeps
sending a revoked key therefore locks only that key's bucket, and a
replacement key on the same address works at once. A valid key clears its own
bucket. The lock is answered as 401, not 429: the key check in `principal()`
(`rust-api/server/src/auth.rs`) reports only that there is no caller, as it
does for a bad key. The limiter is `rust-api/server/src/rate_limit.rs`.

A key grants everything the cookie grants, except the password change and
key management. That includes routes outside this contract: securities,
recurring rules, reports, settings, issue reports, system status, WebMCP, and
every bank-sync route under `/api/b/{bookId}/sync/`. The contract lists what
the client uses. It does not limit what a key can reach.

A native client must not send `Origin` or `Sec-Fetch-Site`. The server's
cross-origin check (`rust-api/server/src/security.rs`) rejects a write whose
`Origin` host differs from `Host`.

## Live updates

`GET /api/b/{bookId}/events` is a Server-Sent Events stream. It accepts a
bearer key like any data route. It is not in `openapi.json`, because a
generated client cannot consume a stream from the document. The client reads
it by hand. The stream authenticates once when it opens and stays open for
up to five minutes. Revoking a key does not close a stream that is already
open. The next reconnect fails.
