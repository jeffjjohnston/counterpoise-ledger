# Working in Git worktrees

Read `CLAUDE.md` and use the current workspace manager's documented controls for
managed branches and checkouts. Do not assume a fixed worktree directory.

Run `npm ci` in a fresh checkout. A nested checkout may resolve tools from a
parent `node_modules`, but an external worktree cannot rely on that. Next.js
Turbopack requires dependencies within its own project root and rejects a
`node_modules` symlink that points outside it.

Vitest discovers only `tests/`, so nested worktrees do not run duplicate suites.
The `agentRules: false` setting in `next.config.js` prevents Next.js from rewriting
`AGENTS.md` on startup. Use a distinct dev-server port and stop only processes
owned by the current task after verification.
