import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rustApiTarget } from "@/vite.config";

// The dev proxy target. A developer who sets RUST_API_URL in .env.local, for
// example for a worktree on another port, must reach that server and not
// another checkout's server on the default port.

describe("rustApiTarget", () => {
  let dir: string;
  const shell = process.env.RUST_API_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vite-env-"));
    delete process.env.RUST_API_URL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (shell === undefined) delete process.env.RUST_API_URL;
    else process.env.RUST_API_URL = shell;
  });

  it("uses the default port when nothing sets it", () => {
    expect(rustApiTarget("development", dir)).toBe("http://127.0.0.1:4000");
  });

  it("reads RUST_API_URL from .env.local", () => {
    writeFileSync(join(dir, ".env.local"), "RUST_API_URL=http://127.0.0.1:4555\n");
    expect(rustApiTarget("development", dir)).toBe("http://127.0.0.1:4555");
  });

  it("lets a shell variable win over the file", () => {
    writeFileSync(join(dir, ".env.local"), "RUST_API_URL=http://127.0.0.1:4555\n");
    process.env.RUST_API_URL = "http://127.0.0.1:4666";
    expect(rustApiTarget("development", dir)).toBe("http://127.0.0.1:4666");
  });
});
