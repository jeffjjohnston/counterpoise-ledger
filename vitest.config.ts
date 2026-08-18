import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "**/*.test.{ts,tsx}"],
    // The broad "**/*" include above otherwise reaches into git worktrees under
    // .claude/worktrees/, running a second copy of every test. If that worktree
    // has its own node_modules, those tests load a second React and fail with
    // "Invalid hook call". Spread the defaults — a bare `exclude` replaces them.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: process.env.CI ? 2 : 8,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "db/**/*.ts",
        "lib/**/*.ts",
        "mcp/**/*.ts",
        "scripts/**/*.ts",
      ],
      exclude: [
        "app/**/*.test.{ts,tsx}",
        "components/**/*.test.{ts,tsx}",
        "db/migrations/**",
        "tests/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
