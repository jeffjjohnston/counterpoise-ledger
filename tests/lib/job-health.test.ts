import { describe, expect, it } from "vitest";
import {
  JOB_SCHEDULES,
  evaluateJobHealth,
  type JobEntry,
} from "@/lib/job-health";

const NOW = new Date("2026-08-09T12:00:00Z");

function entry(over: Partial<JobEntry> & { job: string }): JobEntry {
  return {
    lastRun: NOW.toISOString(),
    lastOk: NOW.toISOString(),
    verified: null,
    bytes: null,
    detail: null,
    ...over,
  };
}

function allHealthy(): JobEntry[] {
  return Object.keys(JOB_SCHEDULES).map((job) =>
    entry({ job, verified: job === "backup" ? true : null })
  );
}

describe("JOB_SCHEDULES", () => {
  it("gives every job a stale threshold beyond its largest legitimate gap", () => {
    for (const [job, cfg] of Object.entries(JOB_SCHEDULES)) {
      expect(
        cfg.staleAfterMs,
        `${job} threshold must exceed its max gap`
      ).toBeGreaterThan(cfg.maxGapMs);
    }
  });

  it("covers exactly the six scheduled jobs", () => {
    expect(Object.keys(JOB_SCHEDULES).sort()).toEqual([
      "backup",
      "plaid-sync",
      "price-sync",
      "prune",
      "recurring",
      "reindex",
    ]);
  });

  it("gives every job a human-readable schedule label", () => {
    for (const [job, cfg] of Object.entries(JOB_SCHEDULES)) {
      expect(cfg.schedule, `${job} needs a schedule label`).toBeTruthy();
      expect(cfg.schedule.trim(), `${job} schedule must not be blank`).not.toBe("");
    }
  });
});

describe("evaluateJobHealth", () => {
  it("reports ok when every job is fresh", () => {
    const result = evaluateJobHealth(allHealthy(), NOW);

    expect(result.overall).toBe("ok");
    expect(result.jobs.every((j) => j.state === "ok")).toBe(true);
  });

  it("reports unknown when the status directory is absent", () => {
    const result = evaluateJobHealth(null, NOW);

    expect(result.overall).toBe("unknown");
    expect(result.jobs.every((j) => j.state === "unknown")).toBe(true);
  });

  it("reports missing for a job that has never written a file", () => {
    const entries = allHealthy().filter((e) => e.job !== "backup");

    const result = evaluateJobHealth(entries, NOW);

    expect(result.overall).toBe("attention");
    expect(result.jobs.find((j) => j.job === "backup")?.state).toBe("missing");
  });

  it("treats a job as ok right up to its threshold", () => {
    const cfg = JOB_SCHEDULES.backup;
    const justInside = new Date(NOW.getTime() - cfg.staleAfterMs + 1000);
    const entries = allHealthy().map((e) =>
      e.job === "backup"
        ? {
            ...e,
            lastOk: justInside.toISOString(),
            lastRun: justInside.toISOString(),
          }
        : e
    );

    expect(
      evaluateJobHealth(entries, NOW).jobs.find((j) => j.job === "backup")?.state
    ).toBe("ok");
  });

  it("reports stale once past the threshold", () => {
    const cfg = JOB_SCHEDULES.backup;
    const justOutside = new Date(NOW.getTime() - cfg.staleAfterMs - 1000);
    const entries = allHealthy().map((e) =>
      e.job === "backup"
        ? {
            ...e,
            lastOk: justOutside.toISOString(),
            lastRun: justOutside.toISOString(),
          }
        : e
    );

    const result = evaluateJobHealth(entries, NOW);

    expect(result.overall).toBe("attention");
    expect(result.jobs.find((j) => j.job === "backup")?.state).toBe("stale");
  });

  it("reports unverified for a fresh dump that failed pg_restore --list", () => {
    const entries = allHealthy().map((e) =>
      e.job === "backup" ? { ...e, verified: false } : e
    );

    const result = evaluateJobHealth(entries, NOW);

    expect(result.overall).toBe("attention");
    expect(result.jobs.find((j) => j.job === "backup")?.state).toBe("unverified");
  });

  it("does not let price-sync alarm over its legitimate weekend gap", () => {
    // Saturday 6am run, evaluated Monday noon — the gap that a naive 24h rule
    // would flag every single week.
    const saturday = new Date("2026-08-08T06:00:00Z");
    const monday = new Date("2026-08-10T12:00:00Z");
    const entries = allHealthy().map((e) =>
      e.job === "price-sync"
        ? {
            ...e,
            lastOk: saturday.toISOString(),
            lastRun: saturday.toISOString(),
          }
        : e
    );

    expect(
      evaluateJobHealth(entries, monday).jobs.find((j) => j.job === "price-sync")
        ?.state
    ).toBe("ok");
  });

  it("ignores unknown job names in the status directory", () => {
    const entries = [...allHealthy(), entry({ job: "not-a-real-job" })];

    const result = evaluateJobHealth(entries, NOW);

    expect(result.jobs.map((j) => j.job)).not.toContain("not-a-real-job");
    expect(result.overall).toBe("ok");
  });

  it("propagates the schedule label for healthy jobs", () => {
    const result = evaluateJobHealth(allHealthy(), NOW);

    expect(result.jobs.find((j) => j.job === "price-sync")?.schedule).toBe(
      "Tue–Sat 6am"
    );
  });

  it("propagates the schedule label when the status directory is absent", () => {
    // The null branch builds its job list separately, so it can silently drop
    // a field the main branch sets — which would blank the column in exactly
    // the local-dev case where the table is most often looked at.
    const result = evaluateJobHealth(null, NOW);

    expect(result.jobs.every((j) => Boolean(j.schedule))).toBe(true);
    expect(result.jobs.find((j) => j.job === "backup")?.schedule).toBe(
      "Hourly, 6am–9pm"
    );
  });
});
