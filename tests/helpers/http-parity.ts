import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "./db-utils";
import { sessions } from "../../db/schema";
import { workerDatabaseUrl } from "./database-safety";

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolveReady, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No TCP port assigned");
  await new Promise<void>((resolveClosed) => socket.close(() => resolveClosed()));
  return address.port;
}

async function waitUntilReady(child: ChildProcess, baseUrl: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`HTTP server exited (${child.exitCode ?? child.signalCode}):\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await delay(200);
  }
  throw new Error(`HTTP server did not become ready:\n${output()}`);
}

/** Start the Rust HTTP server against this Vitest worker's leased database. */
export async function startHttpTestServer(
  overrides: Record<string, string> = {}
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(resolve("rust-api/target/debug/counterpoise-rust-api"), [], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_URL: workerDatabaseUrl(),
      RUST_BIND: `127.0.0.1:${port}`,
      NODE_ENV: "production",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const record = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const error = new Promise<never>((_, reject) => child.once("error", reject));
  const stop = async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      child.kill("SIGTERM");
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await Promise.race([waitUntilReady(child, baseUrl, () => output), error]);
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { baseUrl, stop };
}

/** Create a real session; never bypass the server's auth in an HTTP test. */
export async function sessionHttpClient(baseUrl: string) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    userId: 1,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("cookie", `counterpoise_session=${token}`);
      return fetch(new URL(path, baseUrl), { ...init, headers });
    },
    anonymous(path: string, init: RequestInit = {}) {
      return fetch(new URL(path, baseUrl), init);
    },
  };
}
