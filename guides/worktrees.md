# Working in Git worktrees

Read `CLAUDE.md` and use the current workspace manager's documented controls for
managed branches and checkouts. Do not assume a fixed worktree directory.

Run `npm ci` in a fresh checkout. A nested checkout may resolve tools from a
parent `node_modules`, but an external worktree cannot rely on that.

Vitest discovers only `tests/`, so nested worktrees do not run duplicate suites.
Use a distinct dev-server port and stop only processes owned by the current
task after verification. Start Vite with `npm run dev -- --port <port>`. The
port is strict: when it is in use, Vite stops with an error and does not choose
another port. The Rust API server needs its own port too: start it with
`RUST_BIND=127.0.0.1:<port>`, and start Vite with
`RUST_API_URL=http://127.0.0.1:<port>`, or the Vite proxy sends the API
requests to another checkout's server on the default port 4000.

Each worktree has its own development database: the default `DATABASE_PATH`
is `data/counterpoise.db`, relative to the checkout. A new worktree starts
with no database. Run `npm run db:seed` there, with no server running, for the
sample data. Two worktrees never share a file, so their servers do not stop
each other with the server lock. Build `ledger-cli` in each worktree before
`npm test` (`cargo build --manifest-path rust-api/Cargo.toml -p ledger-cli`):
the database tests run `rust-api/target/debug/ledger-cli` of this checkout.
