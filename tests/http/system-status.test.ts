import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { onWorker, sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { exec } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

// A Durable Object has no file to reindex, so the Worker lists no reindex job.
const NAMES = ["backup", "recurring", "plaid-sync", "price-sync", "prune", "reindex", "weekly-review", "issue-sync"]
  .filter((name) => !onWorker || name !== "reindex");

/** Records a run of `job` in `job_runs`, as the scheduler does. */
async function record(job: string, run: {
  lastRun?: Date; lastOk?: Date | null; verified?: boolean | null; detail?: string | null; notConfigured?: boolean;
} = {}) {
  const lastRun = run.lastRun ?? new Date();
  await exec(
    `INSERT INTO job_runs (job, last_run_at, last_ok_at, verified, bytes, detail, not_configured)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
     ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at,
       verified = excluded.verified, detail = excluded.detail, not_configured = excluded.not_configured`,
    [job, lastRun, run.lastOk === undefined ? lastRun : run.lastOk, run.verified ?? null, run.detail ?? null,
      run.notConfigured ?? false],
  );
}

describe("system status HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => {
    await stop?.();
  });

  it("keeps the status private, and reports unknown before any job has run", async () => {
    expect((await client.anonymous("/api/system/status")).status).toBe(401);
    const response = await client.request("/api/system/status");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.overall).toBe("unknown");
    expect(result.jobs.map((job: { job: string }) => job.job)).toEqual(NAMES);
    expect(result.jobs.every((job: { state: string }) => job.state === "unknown")).toBe(true);
    expect(result.jobs[0]).toMatchObject(
      onWorker
        ? { job: "backup", label: "Database export", schedule: "Daily 3:45am" }
        : { job: "backup", label: "Database backup", schedule: "Hourly, 6am–9pm" }
    );
  });

  it("reports failed and missing monitoring states", async () => {
    await record("backup", { lastOk: null, verified: false, detail: "failed" });
    const result = await (await client.request("/api/system/status")).json();
    expect(result.overall).toBe("attention");
    expect(result.jobs[0]).toMatchObject({ job: "backup", state: "failed", detail: "failed", lastOk: null, ageMs: null });
    expect(result.jobs[1]).toMatchObject({ job: "recurring", state: "missing" });
  });

  it("marks current verified jobs healthy and distinguishes stale from unverified", async () => {
    for (const job of NAMES) await record(job, { verified: true });
    const healthy = await (await client.request("/api/system/status")).json();
    expect(healthy.overall).toBe("ok");
    expect(healthy.jobs.every((job: { state: string }) => job.state === "ok")).toBe(true);
    // Three days is stale on both servers: past the native 12 hours and the
    // Worker's two days for its daily export.
    await record("backup", { lastOk: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), verified: true });
    await record("recurring", { verified: false });
    const degraded = await (await client.request("/api/system/status")).json();
    expect(degraded.overall).toBe("attention");
    expect(degraded.jobs[0].state).toBe("stale");
    expect(degraded.jobs[1].state).toBe("unverified");
  });

  it("reports a job with no secret as not configured, and not as attention", async () => {
    for (const job of NAMES) {
      const none = job === "plaid-sync" || job === "price-sync";
      await record(job, none ? { notConfigured: true, detail: "not configured: PLAID_SECRET is not set" } : {});
    }
    const result = await (await client.request("/api/system/status")).json();
    expect(result.overall).toBe("ok");
    expect(result.jobs[2]).toMatchObject({
      job: "plaid-sync", state: "not_configured", lastOk: null, ageMs: null,
      detail: "not configured: PLAID_SECRET is not set",
    });
    expect(result.jobs[3].state).toBe("not_configured");
    expect(result.jobs[0].state).toBe("ok");
  });
});
