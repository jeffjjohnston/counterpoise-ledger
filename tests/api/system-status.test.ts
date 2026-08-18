import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/session";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as statusGet } from "@/app/api/system/status/route";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-status-api-"));
  process.env.STATUS_DIR = join(dir, "status");
  vi.mocked(getSession).mockResolvedValue({ userId: 1 } as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STATUS_DIR;
  vi.clearAllMocks();
});

function writeEntry(job: string, body: object) {
  mkdirSync(join(dir, "status"), { recursive: true });
  writeFileSync(join(dir, "status", `${job}.json`), JSON.stringify(body));
}

describe("GET /api/health", () => {
  it("responds without a session", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);

    const res = await healthGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("ok", true);
  });

  it("leaks no job detail", async () => {
    writeEntry("backup", {
      job: "backup",
      lastRun: null,
      lastOk: null,
      verified: false,
      bytes: null,
      detail: "secret",
    });

    const body = JSON.stringify(await (await healthGet()).json());

    expect(body).not.toContain("backup");
    expect(body).not.toContain("secret");
  });
});

describe("GET /api/system/status", () => {
  it("requires a session", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);

    expect((await statusGet()).status).toBe(401);
  });

  it("reports unknown when the status directory is absent", async () => {
    const body = await (await statusGet()).json();

    expect(body.overall).toBe("unknown");
  });

  it("surfaces a stale job", async () => {
    writeEntry("backup", {
      job: "backup",
      lastRun: "2026-01-01T00:00:00Z",
      lastOk: "2026-01-01T00:00:00Z",
      verified: true,
      bytes: 1,
      detail: null,
    });

    const body = await (await statusGet()).json();

    expect(body.overall).toBe("attention");
    expect(
      body.jobs.find((j: { job: string }) => j.job === "backup").state
    ).toBe("stale");
  });

  it("ignores an unparseable status file rather than failing the request", async () => {
    mkdirSync(join(dir, "status"), { recursive: true });
    writeFileSync(join(dir, "status", "backup.json"), "{ not json");

    const res = await statusGet();

    expect(res.status).toBe(200);
    expect(
      res.status === 200 &&
        (await res.json()).jobs.find((j: { job: string }) => j.job === "backup")
          .state
    ).toBe("missing");
  });
});
