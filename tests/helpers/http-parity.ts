import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { insert } from "./sql";
import { LEDGER_OBJECT_FILE, workerDatabasePath, workerPersistDirectory } from "./test-database";

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
  // The Worker answers even when its object cannot start: it says why.
  let refusal = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`HTTP server exited (${child.exitCode ?? child.signalCode}):\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      refusal = `${response.status} ${await response.text()}\n`;
      // The object's start failed on a setting: a retry fails the same way.
      if (refusal.includes("The server could not start")) break;
    } catch {
      // The listener is not ready yet.
    }
    await delay(200);
  }
  throw new Error(`HTTP server did not become ready:\n${refusal}${output()}`);
}

type Overrides = Record<string, string> | ((baseUrl: string) => Record<string, string>);

/** Whether the HTTP tests run against the Worker, not the native server. */
export const onWorker = process.env.COUNTERPOISE_HTTP_SERVER === "worker";

/**
 * Start the Rust HTTP server against this Vitest worker's leased database.
 * `overrides` can be a function of the base URL, for a setting that names
 * the server itself (`COUNTERPOISE_PUBLIC_URL`).
 *
 * With `COUNTERPOISE_HTTP_SERVER=worker` the server is the Worker and its
 * Durable Object under `wrangler dev`, on the object's own file.
 */
export async function startHttpTestServer(
  overrides: Overrides = {}
): Promise<{ baseUrl: string; stop: () => Promise<void>; output: () => string }> {
  if (onWorker) return startWorkerTestServer(overrides);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const settings = typeof overrides === "function" ? overrides(baseUrl) : overrides;
  const child = spawn(resolve("rust-api/target/debug/counterpoise-rust-api"), [], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      // Some suites run a second server on the file with other settings.
      COUNTERPOISE_TEST_SHARED_DATABASE: "1",
      RUST_BIND: `127.0.0.1:${port}`,
      NODE_ENV: "production",
      // Tests choose the server's zone with TZ, and compute their dates in
      // this process's TZ. APP_TZ wins over TZ in the server, so it follows
      // TZ unless the test names it.
      APP_TZ: settings.TZ ?? process.env.TZ ?? "",
      ...settings,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = process.env.COUNTERPOISE_SQL_CAPTURE;
  const record = (chunk: Buffer) => {
    if (capture) appendFileSync(capture, chunk);
    output = (output + chunk.toString()).slice(-12_000);
  };
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
  return { baseUrl, stop, output: () => output };
}

/** Create a real session; never bypass the server's auth in an HTTP test. */
export async function sessionHttpClient(baseUrl: string, userId = 1) {
  const token = randomBytes(32).toString("hex");
  await insert("sessions", {
    userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return {
    /** The session's `Cookie` header, for a client that is not `fetch`. */
    cookie: `counterpoise_session=${token}`,
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

const WORKER_ROOT = resolve("rust-api/worker");

/**
 * The settings that the Worker gets from this process, as the native server
 * gets its whole environment: those the server reads. A Worker has no
 * process environment, so each is a variable of its config.
 */
const WORKER_SETTINGS = /^(APP_TZ|TZ|ENABLE_HSTS|REGISTRATION_ENABLED|CRON_SECRET|COUNTERPOISE_|PLAID_|TIINGO_|ANTHROPIC_|TYPESAFE_|ISSUE_SYNC_|POSTHOG_|NEXT_PUBLIC_POSTHOG_)/;

/**
 * `startHttpTestServer` on the Worker: `wrangler dev` on the built Worker
 * (`rust-api/worker/build`, from `npm run worker:build`),
 * with this worker's `--persist-to` directory, so that the object opens the
 * leased file. Its config is written for each start, with the settings as
 * its variables and no build step.
 */
async function startWorkerTestServer(
  overrides: Overrides
): Promise<{ baseUrl: string; stop: () => Promise<void>; output: () => string }> {
  // A port from `freePort` is free when it is chosen, not when wrangler
  // binds it: another Vitest worker can take it in between, and wrangler
  // then exits on "Address already in use". Such a start runs again on new
  // ports.
  for (let attempt = 1; ; attempt++) {
    try {
      return await startWorkerOnce(overrides);
    } catch (cause) {
      if (attempt === 3 || !String(cause).includes("Address already in use")) throw cause;
    }
  }
}

async function startWorkerOnce(
  overrides: Overrides
): Promise<{ baseUrl: string; stop: () => Promise<void>; output: () => string }> {
  const script = join(WORKER_ROOT, "build", "index.js");
  if (!existsSync(script)) {
    throw new Error(`No Worker build at ${script}: run \`npm run worker:build\``);
  }
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const baseUrl = `http://127.0.0.1:${port}`;
  const settings = typeof overrides === "function" ? overrides(baseUrl) : overrides;
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && WORKER_SETTINGS.test(name)) vars[name] = value;
  }
  // No NODE_ENV: a deployed Worker has none (wrangler.toml), so the tests
  // see the defaults it runs with. A test that needs it passes it.
  Object.assign(vars, { APP_TZ: settings.TZ ?? process.env.TZ ?? "" }, settings);
  delete vars.COUNTERPOISE_HTTP_SERVER;
  delete vars.COUNTERPOISE_TEST_RUN_ID;
  const persist = workerPersistDirectory();
  mkdirSync(persist, { recursive: true });
  const config = join(persist, `wrangler-${port}.json`);
  // No pages: an empty assets directory answers 404, as the native server's
  // page service does in these tests.
  const assets = join(persist, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(config, JSON.stringify({
    name: "counterpoise",
    main: script,
    compatibility_date: "2026-10-01",
    assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
    durable_objects: { bindings: [{ name: "LEDGER", class_name: "LedgerObject" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["LedgerObject"] }],
    vars,
  }));
  const child = spawn(
    "bash",
    [
      resolve("scripts/wrangler.sh"), "dev",
      "--config", config,
      "--persist-to", persist,
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", String(inspectorPort),
      "--show-interactive-dev-session=false",
      "--log-level", "warn",
    ],
    {
      cwd: WORKER_ROOT,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  let output = "";
  const record = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-12_000);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const error = new Promise<never>((_, reject) => child.once("error", reject));
  // wrangler starts workerd as a child: stop the whole group.
  const stop = async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch {
        // The group is gone.
      }
    };
    const timer = setTimeout(() => signal("SIGKILL"), 5000);
    try {
      signal("SIGTERM");
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await Promise.race([waitUntilReady(child, baseUrl, () => output), error]);
    // The readiness request reached the object. It opened the leased file
    // only if it made no other one.
    const objects = dirname(join(persist, LEDGER_OBJECT_FILE));
    const files = readdirSync(objects).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
    if (files.length !== 1 || files[0] !== basename(LEDGER_OBJECT_FILE)) {
      throw new Error(`The object opened ${files.join(", ")} in ${objects}, not ${basename(LEDGER_OBJECT_FILE)}`);
    }
  } catch (cause) {
    await stop();
    throw cause;
  }
  // The last of wrangler's output, at warning level and above.
  return { baseUrl, stop, output: () => output };
}
