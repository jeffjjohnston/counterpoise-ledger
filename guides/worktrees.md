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
