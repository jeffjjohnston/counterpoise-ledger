# Testing Guidelines

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## TDD for Agent Development

Before implementation, state the observable behavior, the relevant accounting
or security invariant, and one plausible way the change could be wrong. Choose
the smallest test boundary that can expose that failure. Human oversight should
approve financial semantics, acceptance examples, destructive workflows, and
changes that weaken existing guarantees.

- **New behavior or bug fix:** write a focused test first and observe its intended
  failure. Implement, pass, then refactor. A missing import establishes absent
  scaffolding; it does not prove an assertion detects wrong behavior.
- **Characterization:** passing initially is expected. Verify the captured
  behavior against the requirement before preserving it, including hand-checking
  financial results. Do not encode an observed bug as the desired contract.
- **Refactoring:** existing behavioral tests may suffice. Add tests for identified
  gaps, not for every extracted function or changed file.
- **Cosmetic or documentation changes:** a new permanent test is optional. Use
  visual inspection, link checks, or existing checks as appropriate.
- **Critical regressions:** demonstrate sensitivity with a targeted mutation:
  remove the book filter, bypass rollback, reverse ordering, duplicate processing,
  or ignore a save. The exact intended assertion must fail. An unrelated failure,
  timeout, import error, or broken setup is not evidence.
- **Expected results:** derive them independently. Use small hand-worked financial
  examples and conservation properties, not the production helper to calculate
  its own expected answer.
- **Test removal:** explain which behavior is obsolete or covered elsewhere.
  Preserve meaningful contracts; historical test names and counts are not
  requirements. Do not rewrite unrelated tests to make a change pass.
- **Handoff:** report the contract tested, relevant failure evidence, commands and
  results, and material verification gaps. Reviewers challenge the requirements,
  examples, and failure paths independently. Test counts are inventory.

## Test Boundaries

| Change | Primary evidence |
| --- | --- |
| Accounting, FIFO, recurrence, rounding | Pure tests with independently calculated results, boundary cases, and conservation properties |
| Persistence, ownership, rollback, locking | A real SQLite database (with a Durable Object's limits) through the relevant production path |
| HTTP or MCP adapter | Auth, schema wiring, serialization, error mapping, and surface-specific behavior |
| Interactive UI | User actions and observable results; browser checks for layout and navigation |
| Release, publishing, migration | Execute the real script or artifact against disposable fixtures, including refusal and partial failure |

Test the detailed business-rule matrix primarily where the rule lives. Keep
adapter tests for distinct wiring risks, especially HTTP/MCP validation differences.
Mock external services, clocks, and transport boundaries; do not replace the
database when asserting SQL, transactions, or ownership.

Rollback tests must cause a failure **after a write**, prove that failure was
reached, and assert unchanged persisted state. A pre-validation rejection is a
validation test. Concurrency tests synchronize on explicit signals or the specific
blocked database operation, release holders in `finally`, and never use a fixed
sleep to assume an interleaving happened.

A test that calls a helper on a pooled connection does not cover the
reserved-connection path. Anything reachable from a run that holds a lease
(`rust-api/server/src/leases.rs`), such as the Plaid sync, needs a test
through the lease.

UI tests query accessible roles and labels, interact, and check the result.
An edit must survive reload or reopening; an unchanged row remaining visible
does not establish a save. Avoid assertions on incidental Tailwind classes,
padding, SVG paths, or DOM nesting. Keep explicit class-override contracts.
Check important layout regressions in a browser at relevant viewport widths.

For configuration, use maintained parsers rather than implementing partial
YAML, Actions-expression, or shell parsers inside tests.
Move executable procedures into scripts and test their effects. Keep historical
measurements in one place rather than testing repeated prose for agreement.

## Running and Isolating Tests

- `npm test` runs once. `npm run test:watch` explicitly opts into watch mode.
- `npm run test:node` covers pure logic, schemas, and process tests.
- `npm run test:dom` covers React/UI tests with DOM setup.
- `npm run test:db` covers real SQLite integration.
- Every database suite needs `rust-api/target/debug/ledger-cli`, because each
  worker makes its database with `ledger-cli migrate`. Build it first with
  `cargo build --manifest-path rust-api/Cargo.toml -p ledger-cli`.
- `npm run test:http` runs the HTTP suite against the Rust binary. Build it
  with `cargo build --locked -p counterpoise-rust-api -p ledger-cli
  --manifest-path rust-api/Cargo.toml`. CI runs it. The suite ran
  against the Node server too until the Next API handlers were retired, so
  its snapshots and expected bodies are the ones both servers gave.
  - `COUNTERPOISE_HTTP_SERVER=worker` runs the HTTP suite, and the MCP
    suite with `COUNTERPOISE_MCP_TRANSPORT=http`, against the Worker under
    `wrangler dev` instead: `npm run test:http:worker` and
    `npm run test:mcp:worker`. Build it first with `npm run worker:build`
    (`npm run worker:build`, which needs `worker-build`).
    CI runs the HTTP suite on both targets: the native server in the
    `rust-workspace` job and the Worker in the `worker` job. The MCP tool
    suites run on the native server only; the Worker runs the MCP suites that
    cross its adapter (the HTTP gate, the tool list, the book roles and one
    call of each result kind), because the tools call the same route
    handlers that the HTTP suite already runs on the Worker. Each server gets its own wrangler config, with the
    settings as variables, and a `--persist-to` directory whose object file
    is the worker's test database, so the database helpers write the rows the
    object reads. The tests and the object thus share one file on two
    connections, and workerd does not wait for a lock: an object write
    during a test's write fails with `SQLITE_BUSY` and logs an uncaught
    error. A test's requests and its own writes never overlap, but an alarm
    runs when a job is due, so the test Worker runs with
    `COUNTERPOISE_SCHEDULER=off` and sets no alarm
    (`tests/http/worker-alarm.test.ts`). A test that needs the alarm passes
    `COUNTERPOISE_SCHEDULER: "on"` and must not write to the file while the
    alarm can run. The test Worker has no export bucket, unless a test
    passes `{ exports: true }` as the second argument of
    `startHttpTestServer`: it then gets a local R2 bucket, which
    `putExportsObject` and `hasExportsObject` write and read
    (`tests/http/worker-restore.test.ts`). A Worker has no system zone, so the test Worker gets
    its zone by name as `APP_TZ`: the test's `TZ`, else this process's `TZ`,
    else the zone of the machine (`workerZone()`). Without that, a run with
    no `TZ` puts the Worker on UTC, and the date tests fail in the hours when
    the UTC date is not the local date. `onWorker` from `tests/helpers/http-parity.ts` gives a test
    the Worker's expectation where the targets differ, and
    `vitest.config.ts` leaves out the suites that do not apply there, each
    with its reason. Both targets are production (see
    [architecture.md](architecture.md#deployment-targets)). A change to the
    database code, the jobs, the sockets, the start or `platform.rs` can pass
    on one target and fail on the other. Run the suites on both targets
    before you say such a change is done.
  - `tests/http/rebuild-lots.test.ts` runs `ledger-cli rebuild-lots` on
    seeded, imported and edge-case books, and checks that it rewrites every
    lot and allocation unchanged. It also checks the backfill guard and that
    a failed pair exits 1.
  - `tests/http/seed.test.ts` and `tests/http/moneydance-import.test.ts` run
    `ledger-cli seed` and `ledger-cli import-moneydance` (on both Moneydance
    fixtures in `tests/fixtures/`). Both write dates relative to today, so the
    tests check the counts, the balance and the rows that matter, and that two
    runs write the same rows. `tests/helpers/table-dump.ts` holds the dump
    they compare. Timestamps and password hashes are left out.
  - The Rust seed tests are in `rust-api/db/src/seed/tests.rs`. Snapshot
    tests pin a hash of each dataset (`HOUSEHOLD_2025_12_31`,
    `SINGLE_2026_09_15`). Invariant tests check the balance, the lots and the
    dates at five values of `today`. To update a snapshot after an intended
    generator change, run `cargo test --manifest-path rust-api/Cargo.toml -p
    ledger-db seed -- --nocapture`, copy the printed `actual hash`, and paste
    it into the constant. Do this only for an intended change.
- `npm run test:mcp:http` runs every MCP suite in `tests/mcp` against the Rust
  server over HTTP. `npm run test:mcp:stdio` runs the suites that cross the
  stdio adapter. They need the server binary too. See the transport coverage
  table in [mcp-server.md](mcp-server.md).
- The dev profile builds `scrypt` and its hash crates with `opt-level = 3`
  (`rust-api/Cargo.toml`). Unoptimized, one password hash takes about 0.7 s,
  and each login runs one, so the HTTP auth suite took about 46 s on a
  development machine; it now takes about 3 s. The hash parameters do not
  change, only the code that computes them.
- Some HTTP suites compare full response bodies with snapshots in
  `tests/http/__snapshots__/`. After a deliberate change to one of these
  responses, check the new body by hand, delete the affected snapshot and run
  the suite to write it again. Run with `CI=1` to make a missing snapshot fail
  instead of being written.
- `npm run test:e2e` builds and starts its own server on `.e2e/counterpoise.db`. It refuses an occupied port
  rather than silently testing another checkout's server. As on the Docker
  target, there is one server: `playwright.config.ts` runs `npx vite build`, then the
  Rust server with `RUST_BIND=127.0.0.1:3001` and `COUNTERPOISE_STATIC_DIR=build`.
  The Rust server serves the client build and the API on `http://127.0.0.1:3001`.
  `tests/e2e/static-client.spec.ts` checks the static client: a deep link
  after a reload, Back, the not-found page, and a 404 for a missing chunk.
- Rust workspace checks: `cargo fmt --all --check --manifest-path rust-api/Cargo.toml`,
  `cargo clippy --workspace --all-targets --manifest-path rust-api/Cargo.toml -- -D warnings`,
  and `cargo test --workspace --manifest-path rust-api/Cargo.toml`. The Rust
  tests need no database server: `ledger_db::testing::TempDatabase` makes a
  migrated SQLite file in the temporary directory for each test. One test
  asserts the pragmas, and that no SQL function is registered, on every
  pooled connection. Every connection has a Durable Object's limits, so a
  statement with more than 100 bound parameters fails in any test.
- With Homebrew's `rust` and `rust-wasm`, build the browser target using the
  configuration supplied by `rust-wasm`. That configuration links with
  `wasm-ld`, which Homebrew's `lld` formula supplies (`brew install lld`).
  Without it, the crate compiles and the link fails with "linker `wasm-ld`
  not found":

  ```bash
  cargo build --config "$(brew --prefix rust-wasm)/share/rust-wasm/cargo-config.toml" \
    -p ledger-core --target wasm32-unknown-unknown \
    --manifest-path rust-api/Cargo.toml
  ```

  The Homebrew target libraries live in a separate sysroot, so the plain
  `cargo build --target wasm32-unknown-unknown` command cannot find `core`.
  CI installs the target through `rustup` and uses the plain command there.
- `lib/wasm/generated/` holds the browser copy of `ledger-core`: the crate
  compiled with its `wasm` feature, then `wasm-bindgen` 0.2.130 and
  `wasm-opt`. `scripts/build-core-wasm.mjs` makes it. The Vitest global
  setup (`tests/global-setup.ts`) and a Vite plugin (`buildCoreWasm` in
  `vite.config.ts`) run the script, so each Vitest run (`npm test`,
  `npx vitest`), `npm run dev`, `npm run build` and the E2E build get a
  current module. The script records a hash of its inputs (the core's
  sources and manifests, the lock file and the script) in
  `lib/wasm/generated/inputs.sha256`. When the hash is the same and each
  output file is there, it starts no tool. After a change of `rustc`,
  `wasm-bindgen` or `wasm-opt`, run `node scripts/build-core-wasm.mjs
  --force`: the hash does not include the toolchain. Before `npx tsc` in a
  clean checkout, run `npm run core:wasm:build`: the type check reads the
  generated files and runs neither Vitest nor Vite.

  The generated files are ignored: Homebrew and rustup produce different
  bytes, and committing either build would make the other toolchain dirty
  the tree. Install the CLI with `cargo install wasm-bindgen-cli --version
  0.2.130 --locked` and Binaryen with `brew install binaryen`. If the CLI is
  outside `PATH`, set `WASM_BINDGEN` to its binary path. The build script
  checks the active `rustc` sysroot before selecting the Homebrew `rust-wasm`
  config and `lld@22`; rustup uses its own target and linker. Docker compiles
  the same target in a Rust build stage (`wasm-builder` in the root
  `Dockerfile`) and passes the optimized bindings to the `client` stage,
  which runs the Vite build with `CORE_WASM_PREBUILT=1`. The CI jobs that
  import the browser adapter build it from the Rust source first, with
  `npm run core:wasm:build`, including unit, e2e, type checking, and the
  vacuity pass.
- `rust-api/core/fixtures/core.json` is the corpus that the Rust core test
  checks. The TypeScript helpers generated it until the TypeScript server was
  retired; it is now test data. Add an edge case to it by hand alongside a
  change to the shared logic, then make the Rust implementation pass the new
  case. The corpus fixes the clock to a UTC date for floating-date and
  fixed-price examples. The TypeScript copies of the core and their tests are
  deleted, and their cases are in the corpus, so a TypeScript test of a core
  function goes there too. A case that JSON cannot carry (NaN, an infinity)
  goes in a unit test of the Rust module. `tests/fixtures.rs` fails when the
  corpus has fewer cases than its floor: increase the floor when you add
  cases.
- `rust-api/core/tests/properties.rs` checks the accounting invariants on
  random inputs from a fixed seed: a lot replay conserves shares and basis,
  takes lots first in, first out, and does not depend on the input order;
  the buy, sell and dividend builders give splits that sum to zero. A random
  test in `rust-api/db/src/lots.rs` checks that a stepped rebuild equals a
  whole rebuild. The generator is in the test files, so they add no
  dependency. A failure prints its seed. When you change the replay or a
  builder, add the new rule there, and plant a defect to see the test fail.
- `node scripts/rust-coverage.mjs` reports which lines of the Rust workspace
  the tests run: `cargo test --workspace`, then the HTTP suite and the MCP
  suite against an instrumented server (`--unit-only` leaves the two suites
  out). It needs `llvm-profdata` and `llvm-cov` (the rustup component
  `llvm-tools`, or `brew install llvm`), builds into
  `rust-api/target/coverage` (about 3 GB; delete it afterwards), and took
  about 2 minutes on a development machine. Like the TypeScript report, it locates code
  that no test runs; it sets no percentage. The test helpers take the path
  of a Rust binary from `rustBinary()` in `tests/helpers/rust-binaries.ts`,
  which reads `COUNTERPOISE_RUST_BIN_DIR`: do not write
  `rust-api/target/debug` in a test.
- `npm run test:coverage` reports coverage; use it to locate gaps, not as a
  correctness quota.

`vitest.config.ts` owns project membership. Add new persistence suites to its
database list. Tests belong under `tests/`; worktrees are outside discovery.
Shared helpers live under `tests/helpers/`.

A component test that renders a `Link` or calls a router hook mocks
`@/lib/navigation`, not `next/navigation`. `vi.mock` needs each export that
the component uses, so use `mockNavigation()` from `tests/helpers/navigation.tsx`
and give only what the test cares about:

```ts
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);
```

A test that copies its harness on purpose, so that a shared fixture cannot
change what it checks, writes the whole mock inline
(`TransactionFormInvestmentPayload.test.tsx`).

For a route, add cases under `tests/http/` using `startHttpTestServer()` and
`sessionHttpClient()` from `tests/helpers/http-parity.ts`. Seed rows through
the database helpers, and send real requests through the client. The client
checks the contract itself: when a request is an operation of
`openapi/openapi.json` and the response is a success, the body must match the
schema of that operation, with no key that the schema does not declare
(`assertResponseContract` in `tests/helpers/contract.ts`). A test thus checks
the contract of each route it calls, also when it looks at one field only. A
request that breaks the contract on purpose (a number where the contract has
a string) passes `{ contract: false }` as the third argument of
`client.request`, with a comment that says why. `contract("<ComponentName>")`
from the same file validates one value against a component schema, for a
body that did not come through the client. A route that is not in the
document is not checked: add it to the contract first (see
[api-contract.md](api-contract.md)). `COUNTERPOISE_HTTP_SERVER=rust` (set by `npm run test:http`)
adds the suite to the database project. The HTTP suite uses the same generated
per-worker database, migrations, and reset as other Vitest database
suites. Start the server after `setupTestDatabase()` so it receives that
worker's `DATABASE_PATH`; stop it in `afterAll`. `startHttpTestServer()`
starts each server with `COUNTERPOISE_TEST_SHARED_DATABASE=1`, which turns off
the server lock, because a suite can start more than one server on one file.
Never set it outside tests. A start is ready only after the server itself
reported that it listens on its port (the native server's "Rust API
listening" line, wrangler's "Ready on" line), and then answered
`/api/version`. The answer alone is not proof: the port is chosen before the
server binds it, another Vitest worker can bind it first, and that worker's
server then answers on it. Such a start once sent a file's requests to
another worker's database, and each valid key got 401
(`tests/http/test-server-port.test.ts`). The HTTP suite
covers account reads and writes, payee writes, the transaction register and
transaction CRUD, investments and securities, security prices and the Tiingo
fetch, recurring rules and their processing, Plaid connections, account
mappings, the Plaid Hosted Link sessions, the sync, reconciliation, the sync
reads, live updates, TypeSafe
settings, suggestions and retention, the scheduled jobs (`/api/cron/*`),
version, book and member management, demo book creation, issue reports,
health, job status, and WebMCP.

### Test databases

Tests need no Docker and no database server. Each Vitest run generates a run
id (`<epoch seconds>_<12 hex>`) in `vitest.config.ts`. Each worker uses its
own file, `<tmpdir>/counterpoise_tests/<run id>/worker-<N>.db`
(`tests/helpers/test-database.ts`). `setupTestDatabase()` makes the file with
`ledger-cli migrate` and writes the baseline rows: user 1 owns book 1.
`resetTestDatabase()` deletes every row, restarts the ID sequences and writes
the baseline rows again. `tests/setup.ts` sets `DATABASE_PATH` to the
worker's file.

The run id is **generated, not assigned**. An assigned slot needs an arbiter,
and two agents that got the same slot once destroyed each other's data. A run
that names its own directory cannot collide with another run, in this
checkout or in another worktree. `tests/global-setup.ts` deletes the run's
directory when the run ends. A stopped run can leave its directory behind;
the seconds in the name tell you its age. Delete an old one by hand.

A destructive helper refuses a path outside `<tmpdir>/counterpoise_tests/`
and `.e2e/` (`assertTestDatabasePath`). Do not weaken that check to make a
test run.

`tests/helpers/sql.ts` runs raw SQL on the worker's file with Node's built-in
`node:sqlite` (`rows`, `scalar`, `script`, `insert`). Use it for fixtures and
for checks of stored rows. `node:sqlite` does not register the app's SQL
functions, so do not use `lower()` or `LIKE` in a test query
where the answer depends on them.

E2E uses `.e2e/counterpoise.db`. The server creates and migrates it when it
starts, and the Playwright global setup writes the E2E user and book.

Read-only browser specs may share the global seed. Every ledger-mutating spec
uses `tests/e2e/fixtures.ts` for a separate book per test and retry. Fixtures
clean up only the book they created. Assert exact results, not ranges widened to
accommodate another test's writes. Prefer response waits or retrying assertions
over fixed delays. Failure traces and screenshots are retained.

## Verification and Regression Evidence

Run focused tests in the inner loop. At handoff, run lint, `npx tsc --noEmit`,
the full Vitest suite, and relevant browser/build checks. Reuse a completed run
while code, dependencies, environment, and concerns remain unchanged; repeat
checks after relevant changes. Do not repeat the entire suite solely because a
new workflow step began.

For regression evidence, run a targeted behavioral mutation in an isolated
checkout. Require a green baseline and the intended assertion failure against
the mutation. Collection errors, unrelated failures and a mutation that still
passes do not establish that the test detects the defect.

## After Making Code Changes
After modifying TypeScript files, always run `npx tsc --noEmit` to check for type errors and fix any that arise before considering the task complete.

Run that exact command — `release.sh` and CI do, and it is the one that gates a
release. In particular do **not** verify with `--incremental false`: it bypasses
`tsconfig.tsbuildinfo` and so cannot reproduce what the release gate sees.

If `tsc` reports errors that contradict `tsconfig.json` — classically
`TS2737: BigInt literals are not available when targeting lower than ES2020`
while `target` already says ES2020 — the incremental cache is replaying
diagnostics recorded under the previous options. Changing `target` does not
reliably invalidate them. Delete `tsconfig.tsbuildinfo` and re-run; the
regenerated cache is correct from then on. This is local only: the file is
gitignored, so CI never sees it.

## Reading an exit code through a pipe

A pipeline reports the exit status of its **last** command, not of the command
that failed. `some-check | tail -5` therefore reports `tail`'s status, and
`tail` almost always succeeds. The check can fail and the shell still says 0.

Most of the bash scripts in `scripts/` set `-euo pipefail`, so a pipeline
inside them reports the rightmost failure. Do not assume it: several set less
than that — `scripts/check-compose-cwd.sh` sets only `-e`, the sourced
`scripts/lib/release-commit.sh` sets no options at all, and
`mcp-dev-server.sh` sets only `-a` — and no `/bin/sh` script can set `pipefail`, because it is not
POSIX. Read the options line of the script in front of you rather than trusting
a list to stay complete. An interactive shell does not set it either, and neither does a
one-off command an agent runs. That gap is where this bites: the script may be
safe, and the command you inspect it with is not.

Two separate agents hit this on the same day, each piping a long repo check
into `tail`. Both read "exited with code 0" from a run that had failed, and both
lost a cycle to it.

To check whether something passed, redirect and read the file:

```bash
npm run lint >/tmp/lint.log 2>&1; echo "exit=$?"
tail -20 /tmp/lint.log
```

Or turn the option on for that one command:

```bash
set -o pipefail; npm run lint | tail -5; echo "exit=$?"
```

Two things to know before reaching for `pipefail` everywhere:

- `grep` exits 1 when it matches nothing. Under `pipefail` a pipeline ending in
  a filter that finds no matches reports failure, which is correct and is
  usually not what the caller meant. Do not add `|| true` to silence it — that
  restores the original defect. Test what you actually mean.
- A script that writes state only on success is a second, independent signal:
  the artefact answers "did it finish" without any exit code. Pick the
  artefact written LAST, though — `deploy.sh` publishes its version tag
  before it builds, so a published tag proves the deploy started and nothing
  more. A test pins that: the tag survives a failed build.
