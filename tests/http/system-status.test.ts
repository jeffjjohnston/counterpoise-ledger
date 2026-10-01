import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

describe("system status HTTP parity", () => {
  let root: string;
  let statusDir: string;
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  beforeAll(async () => {
    await setupTestDatabase();
    root = await mkdtemp(join(tmpdir(), "counterpoise-status-"));
    statusDir = join(root, "status");
    ({ baseUrl, stop } = await startHttpTestServer({ STATUS_DIR: statusDir }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    await rm(statusDir, { recursive: true, force: true });
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => {
    await stop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("keeps a missing status directory private and unknown", async () => {
    expect((await client.anonymous("/api/system/status")).status).toBe(401);
    const response = await client.request("/api/system/status");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.overall).toBe("unknown");
    expect(result.jobs).toHaveLength(6);
    expect(result.jobs.every((job: { state: string }) => job.state === "unknown")).toBe(true);
  });

  it("reports failed, missing, and unreadable monitoring states", async () => {
    await mkdir(statusDir);
    await writeFile(join(statusDir, "backup.json"), JSON.stringify({ job: "backup", lastRun: new Date().toISOString(), lastOk: null, verified: false, bytes: null, detail: "failed" }));
    await writeFile(join(statusDir, "bad.json"), "invalid JSON");
    const result = await (await client.request("/api/system/status")).json();
    expect(result.overall).toBe("attention");
    expect(result.jobs[0]).toMatchObject({ job: "backup", state: "failed", detail: "failed", lastOk: null, ageMs: null });
    expect(result.jobs[1]).toMatchObject({ job: "recurring", state: "missing" });

    await rm(statusDir, { recursive: true });
    await writeFile(statusDir, "not a directory");
    const unreadable = await (await client.request("/api/system/status")).json();
    expect(unreadable.overall).toBe("attention");
    expect(unreadable.error).toBe("Status directory unreadable (ENOTDIR)");
    expect(unreadable.jobs.every((job: { state: string }) => job.state === "unknown")).toBe(true);
  });

  it("marks current verified jobs healthy and distinguishes stale from unverified", async () => {
    await mkdir(statusDir);
    const names = ["backup", "recurring", "plaid-sync", "price-sync", "prune", "reindex"];
    const current = new Date().toISOString();
    for (const job of names) {
      await writeFile(join(statusDir, `${job}.json`), JSON.stringify({ job, lastRun: current, lastOk: current, verified: true, bytes: null, detail: null }));
    }
    const healthy = await (await client.request("/api/system/status")).json();
    expect(healthy.overall).toBe("ok");
    expect(healthy.jobs.every((job: { state: string }) => job.state === "ok")).toBe(true);
    await writeFile(join(statusDir, "backup.json"), JSON.stringify({ job: "backup", lastRun: current, lastOk: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(), verified: true, bytes: null, detail: null }));
    await writeFile(join(statusDir, "recurring.json"), JSON.stringify({ job: "recurring", lastRun: current, lastOk: current, verified: false, bytes: null, detail: null }));
    const degraded = await (await client.request("/api/system/status")).json();
    expect(degraded.overall).toBe("attention");
    expect(degraded.jobs[0].state).toBe("stale");
    expect(degraded.jobs[1].state).toBe("unverified");
  });

  it("reports a job with no secret as not configured, and not as attention", async () => {
    await mkdir(statusDir);
    const names = ["backup", "recurring", "plaid-sync", "price-sync", "prune", "reindex"];
    const current = new Date().toISOString();
    for (const job of names) {
      const record = { job, lastRun: current, lastOk: current, verified: null, bytes: null, detail: null };
      const none = job === "plaid-sync" || job === "price-sync"
        ? { notConfigured: true, detail: "not configured: PLAID_SECRET is not set" }
        : {};
      await writeFile(join(statusDir, `${job}.json`), JSON.stringify({ ...record, ...none }));
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
