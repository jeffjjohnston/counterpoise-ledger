import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

/**
 * Follows the output of a test server: keeps its last lines, and tells when
 * the server itself reported that it listens on its port.
 *
 * THE REPORT IS THE PROOF THAT THE PORT IS THIS SERVER'S. A port from
 * `freePort` is free when it is chosen, not when the server binds it. Another
 * Vitest worker can get the same port and bind it first. This server then
 * stops on "Address already in use", but the Worker needs about one second
 * to do that, and in that second the other server answers on the port. A
 * start that trusted the answer alone took that server for its own. Its
 * tests then sent their requests to a server on another worker's database:
 * each request with a key or a session of this worker got 401, and each
 * test of a refusal passed. Only one server can bind a port, so a server
 * that reports the port holds it.
 *
 * `listening` finds the report in one line without its colour codes.
 * `keep` drops the lines that are not for the test's output.
 */
function followOutput(
  child: ChildProcess,
  listening: (line: string) => boolean,
  keep: (line: string) => boolean = () => true
): { output: () => string; listens: () => boolean } {
  let output = "";
  let pending = "";
  let listens = false;
  const capture = onWorker ? undefined : process.env.COUNTERPOISE_SQL_CAPTURE;
  const record = (chunk: Buffer) => {
    if (capture) appendFileSync(capture, chunk);
    const lines = (pending + chunk.toString()).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!listens && listening(line.replace(/\u001b\[[0-9;]*m/g, ""))) listens = true;
      if (keep(line)) output = `${output}${line}\n`.slice(-12_000);
    }
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  // The last line can have no line end, for example when the server stops.
  return { output: () => output + pending, listens: () => listens };
}

async function waitUntilReady(
  child: ChildProcess,
  baseUrl: string,
  output: () => string,
  listens: () => boolean
): Promise<void> {
  const deadline = Date.now() + 90_000;
  // The Worker answers even when its object cannot start: it says why.
  let refusal = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`HTTP server exited (${child.exitCode ?? child.signalCode}):\n${output()}`);
    }
    // An answer before the report can come from another server on the port.
    if (!listens()) {
      await delay(50);
      continue;
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
  const report = listens() ? "" : "The server did not report that it listens on its port.\n";
  throw new Error(`HTTP server did not become ready:\n${report}${refusal}${output()}`);
}

type Overrides = Record<string, string> | ((baseUrl: string) => Record<string, string>);

/** What a test can ask of the test Worker. The native server ignores it. */
interface WorkerOptions {
  /** Binds a local R2 bucket as EXPORTS. Without it the test Worker has no bucket. */
  exports?: boolean;
}
type HttpTestServer = { baseUrl: string; stop: () => Promise<void>; output: () => string };

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
  overrides: Overrides = {},
  options: WorkerOptions = {}
): Promise<HttpTestServer> {
  // A port from `freePort` can be taken before the server binds it (see
  // `followOutput`). The server then exits on "Address already in use". Such
  // a start runs again on a new port.
  for (let attempt = 1; ; attempt++) {
    try {
      return await startHttpTestServerOn(await freePort(), overrides, options);
    } catch (cause) {
      if (attempt === 3 || !String(cause).includes("Address already in use")) throw cause;
    }
  }
}

/**
 * One start of the server on `port`, with no second attempt. For
 * `startHttpTestServer`, and for the test of a port that is taken
 * (`tests/http/test-server-port.test.ts`).
 */
export async function startHttpTestServerOn(
  port: number,
  overrides: Overrides = {},
  options: WorkerOptions = {}
): Promise<HttpTestServer> {
  if (onWorker) return startWorkerOnce(port, overrides, options);
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
  // The server logs this line, at level info, when it has bound the port.
  // A RUST_LOG that hides the line stops the start.
  const { output, listens } = followOutput(
    child,
    (line) => line.includes("Rust API listening") && line.includes(`127.0.0.1:${port}`)
  );
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
    await Promise.race([waitUntilReady(child, baseUrl, output, listens), error]);
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { baseUrl, stop, output };
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
 * The name of the local bucket that the test Worker gets as EXPORTS
 * (`exports` of `startHttpTestServer`). No deployed Worker uses this name.
 */
const TEST_EXPORTS_BUCKET = "counterpoise-test-exports";

/**
 * Runs `wrangler r2 object` on the local bucket in this Vitest worker's
 * persist directory. `--local` keeps the command off Cloudflare.
 */
function exportsObject(action: "put" | "get", key: string, file: string) {
  const persist = workerPersistDirectory();
  mkdirSync(persist, { recursive: true });
  return spawnSync(
    "bash",
    [
      resolve("scripts/wrangler.sh"), "r2", "object", action, `${TEST_EXPORTS_BUCKET}/${key}`,
      "--file", file,
      "--local",
      "--persist-to", persist,
    ],
    // The persist directory has no wrangler config, so the command reads none.
    { cwd: persist, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, encoding: "utf8" }
  );
}

/** Writes `text` as `key` in the test Worker's local export bucket. */
export function putExportsObject(key: string, text: string): void {
  const file = join(workerPersistDirectory(), `exports-put-${randomBytes(6).toString("hex")}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const result = exportsObject("put", key, file);
  if (result.status !== 0) {
    throw new Error(`The export bucket did not take ${key}:\n${result.stdout}${result.stderr}`);
  }
}

/** Whether the test Worker's local export bucket has `key`. */
export function hasExportsObject(key: string): boolean {
  const file = join(workerPersistDirectory(), `exports-get-${randomBytes(6).toString("hex")}`);
  return exportsObject("get", key, file).status === 0 && existsSync(file);
}

/**
 * The settings that the Worker gets from this process, as the native server
 * gets its whole environment: those the server reads. A Worker has no
 * process environment, so each is a variable of its config.
 */
/**
 * The zone that the test Worker gets as APP_TZ: the TZ of the test, else the
 * TZ of this process, else the zone of the machine.
 */
export function workerZone(testZone: string | undefined, processZone: string | undefined): string {
  return testZone ?? (processZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
}

const WORKER_SETTINGS = /^(APP_TZ|TZ|ENABLE_HSTS|REGISTRATION_ENABLED|CRON_SECRET|COUNTERPOISE_|PLAID_|TIINGO_|ANTHROPIC_|TYPESAFE_|ISSUE_SYNC_)/;

/**
 * `startHttpTestServerOn` on the Worker: `wrangler dev` on the built Worker
 * (`rust-api/worker/build`, from `npm run worker:build`),
 * with this worker's `--persist-to` directory, so that the object opens the
 * leased file. Its config is written for each start, with the settings as
 * its variables and no build step.
 */
async function startWorkerOnce(port: number, overrides: Overrides, options: WorkerOptions): Promise<HttpTestServer> {
  const script = join(WORKER_ROOT, "build", "index.js");
  if (!existsSync(script)) {
    throw new Error(`No Worker build at ${script}: run \`npm run worker:build\``);
  }
  const inspectorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const settings = typeof overrides === "function" ? overrides(baseUrl) : overrides;
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && WORKER_SETTINGS.test(name)) vars[name] = value;
  }
  // No NODE_ENV: a deployed Worker has none (wrangler.toml), so the tests
  // see the defaults it runs with. A test that needs it passes it.
  // No alarm, unless the test asks for it: the tests write to the object's
  // file on their own connection, and workerd does not wait for a lock. An
  // alarm that writes during a test's write fails with SQLITE_BUSY and logs
  // an uncaught error. The native test server has no scheduler either.
  // The zone: a Worker has no system zone, so with no APP_TZ and no TZ it
  // runs on UTC. The tests compute their dates in this process's zone. With
  // no TZ that is the zone of the machine, so the Worker gets it by name.
  const zone = workerZone(settings.TZ, process.env.TZ);
  Object.assign(vars, { APP_TZ: zone, COUNTERPOISE_SCHEDULER: "off" }, settings);
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
    ...(options.exports ? { r2_buckets: [{ binding: "EXPORTS", bucket_name: TEST_EXPORTS_BUCKET }] } : {}),
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
      // Level info, for wrangler's "Ready on" line: see below.
      "--log-level", "info",
    ],
    {
      cwd: WORKER_ROOT,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  // wrangler prints "Ready on" when workerd has bound the port. That line and
  // the line of each request are at level info; the test's output keeps the
  // lines at warning level and above only.
  const { output, listens } = followOutput(
    child,
    (line) => line.includes(`Ready on ${baseUrl}`),
    (line) => !line.startsWith("[wrangler:info]")
  );
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
    await Promise.race([waitUntilReady(child, baseUrl, output, listens), error]);
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
  return { baseUrl, stop, output };
}
