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
| Persistence, ownership, rollback, locking | Real PostgreSQL integration through the relevant production path |
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

Calling a lib function with pooled `getDb()` does not cover the reserved-connection
path. Anything reachable from `withAdvisoryLock` needs a test through the lock.

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
- `npm run test:db` covers real PostgreSQL integration.
- `npm run test:e2e` builds and starts its own server. It refuses an occupied port
  rather than silently testing another checkout's server.
- `npm run test:coverage` reports coverage; use it to locate gaps, not as a
  correctness quota.

`vitest.config.ts` owns project membership. Add new persistence suites to its
database list or to `tests/api/`. Tests belong under `tests/`; worktrees are
outside discovery. Shared helpers live under `tests/helpers/`.

Start `docker compose -f docker-compose.dev.yml up -d --wait`, then run
`npm run db:create-test-dbs` once; it creates `counterpoise_dev` and
`counterpoise_e2e`, and Vitest needs neither. Each Vitest run generates a run id
and each worker creates `counterpoise_test_<run id>_<pool>` as its suite starts,
so runs never share a database and nothing has to be assigned. Each worker
validates its exact destination and holds a database lease throughout its suite;
with generated names, a lease that refuses now means two runs derived one name,
which is a defect rather than contention. An inherited `DATABASE_URL` for dev,
production, another run, or another worker is rejected. Clear an unintended
inherited value; never weaken the check to make tests run. E2E setup similarly
validates and leases `counterpoise_e2e` for the whole run.

The run id is `<epoch seconds>_<12 hex>`. The seconds are there for the sweeper:
they let it read a database's age from the name, with no privileged call.

The databases a run leaves behind can be reclaimed with
`scripts/scheduler/sweep-test-databases.sh`, dropping only names of that exact
shape whose creation time is more than
twelve hours old and that have no session connected. Twelve, not two: the name
records when the run **started**, so the age has to cover a whole `--watch`
session rather than an idle gap inside one. The job never touches
`counterpoise_e2e`, a name outside the shape, or a database in use, and it never
forces a drop past a connected session. Slot-derived
`counterpoise_test_<slot>_<pool>` databases, and the untimed
`counterpoise_test_<key>_<pool>` names that preceded the timestamp, are both
outside its pattern; drop them by hand once no worktree still uses them.

**The dev container sweeps itself, every two hours at :30.** `crond` runs
beside postgres inside `counterpoise-dev-postgres-1` — not in a scheduler
service of its own, because the only thing the dev sweep talks to is the
database in that same container, and a developer machine should not run a
second container to hold one crontab line. `docker-compose.dev.yml` carries the
entrypoint override and the reasons. Read a run's outcome with:

```bash
docker logs counterpoise-dev-postgres-1 2>&1 | grep test-db-sweep
```

Production does **not** run test-database cleanup; its scheduler's sweep entry
was removed when the two instances were split. Nothing schedules a sweep of the
production instance, by design — the suite no longer creates databases there.

To sweep by hand, from the host, against the dev instance:

```bash
SWEEP_DATABASE_URL=postgresql://counterpoise:counterpoise@localhost:5432/postgres \
STATUS_DIR=/tmp/counterpoise-sweep \
  ./scripts/scheduler/sweep-test-databases.sh          # add SWEEP_DRY_RUN=1 to look first
```

`localhost:5432` is the **dev** instance: it is the only one publishing a host
port. Reaching the production instance takes `docker exec` into
`counterpoise-postgres-1`, and there is no test-database cleanup owed there.

It will not touch the databases the earlier naming schemes built, and on a
long-lived checkout there can be more of those than of these. Drop them by
hand once no worktree uses them; the pattern is deliberately too narrow to
reach them.

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
than that — `scripts/postgres-init/01-app-role.sh` sets only `-e`, the sourced
`scripts/lib/release-commit.sh` sets no options at all, and `mcp-dev-server.sh`
sets only `-a` — and no `/bin/sh` script can set `pipefail`, because it is not
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
