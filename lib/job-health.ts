const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type JobName =
  | "backup"
  | "prune"
  | "recurring"
  | "plaid-sync"
  | "price-sync"
  | "reindex";

export type JobState =
  | "ok"
  | "stale"
  | "unverified"
  | "failed"
  | "missing"
  | "unknown";

export type JobEntry = {
  job: string;
  lastRun: string | null;
  lastOk: string | null;
  verified: boolean | null;
  bytes: number | null;
  detail: string | null;
};

export type JobHealth = {
  job: JobName;
  label: string;
  schedule: string;
  state: JobState;
  lastOk: string | null;
  ageMs: number | null;
  detail: string | null;
};

/**
 * Each threshold sits past the job's largest *legitimate* gap. Getting this
 * wrong in either direction destroys the signal: too tight and price-sync
 * alarms every Monday over its normal Sat->Tue gap; too loose and a dead
 * backup job goes unreported for a full day.
 *
 * maxGapMs documents the schedule's own worst case so a test can assert the
 * threshold still exceeds it after any crontab edit.
 */
export const JOB_SCHEDULES: Record<
  JobName,
  { maxGapMs: number; staleAfterMs: number; label: string; schedule: string }
> = {
  // hourly 6am-9pm -> 9h overnight gap
  backup: {
    maxGapMs: 9 * HOUR,
    staleAfterMs: 12 * HOUR,
    label: "Database backup",
    schedule: "Hourly, 6am–9pm",
  },
  // hourly
  recurring: {
    maxGapMs: 1 * HOUR,
    staleAfterMs: 3 * HOUR,
    label: "Recurring transactions",
    schedule: "Hourly",
  },
  // every 6h
  "plaid-sync": {
    maxGapMs: 6 * HOUR,
    staleAfterMs: 13 * HOUR,
    label: "Bank sync",
    schedule: "Every 6h",
  },
  // Tue-Sat 6am -> 3d Sat->Tue gap
  "price-sync": {
    maxGapMs: 3 * DAY,
    staleAfterMs: 4 * DAY,
    label: "Security prices",
    schedule: "Tue–Sat 6am",
  },
  // daily 4am
  prune: {
    maxGapMs: 1 * DAY,
    staleAfterMs: 2 * DAY,
    label: "Backup pruning",
    schedule: "Daily 4am",
  },
  // monthly on the 1st
  reindex: {
    maxGapMs: 31 * DAY,
    staleAfterMs: 35 * DAY,
    label: "Reindex",
    schedule: "Monthly, 1st 3am",
  },
};

const JOB_NAMES = Object.keys(JOB_SCHEDULES) as JobName[];

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Four distinct ways a job can be unhealthy, and they call for different
 * responses:
 *
 *   missing    — no file at all; the job has never written status
 *   failed     — it ran and errored (lastRun set, lastOk not)
 *   stale      — it last succeeded too long ago
 *   unverified — it completed, but the artifact it produced is unreadable
 *
 * Collapsing "failed" into "missing" (the original shape) reported a job that
 * ran and blew up as one that had never run, and made "unverified" unreachable
 * for the corrupt-dump case it exists to detect.
 */
function stateFor(
  entry: JobEntry | undefined,
  cfg: { staleAfterMs: number },
  now: number
): { state: JobState; ageMs: number | null } {
  if (!entry) return { state: "missing", ageMs: null };

  const lastOk = parseTime(entry.lastOk);
  if (lastOk === null) {
    // The file exists, so the job ran; it just never reported success.
    return { state: parseTime(entry.lastRun) === null ? "missing" : "failed", ageMs: null };
  }

  const ageMs = now - lastOk;
  if (ageMs > cfg.staleAfterMs) return { state: "stale", ageMs };
  if (entry.verified === false) return { state: "unverified", ageMs };
  return { state: "ok", ageMs };
}

/**
 * `entries === null` means the status directory itself is absent — the local
 * dev case with no ./backups mount, reported as "unknown" and never as a
 * problem. A directory that exists but omits a job yields "missing", which is
 * a real problem. Collapsing the two would make a job that stopped writing
 * indistinguishable from ordinary local development.
 */
export function evaluateJobHealth(
  entries: JobEntry[] | null,
  now: Date
): { overall: "ok" | "attention" | "unknown"; jobs: JobHealth[] } {
  const nowMs = now.getTime();

  if (entries === null) {
    return {
      overall: "unknown",
      jobs: JOB_NAMES.map((job) => ({
        job,
        label: JOB_SCHEDULES[job].label,
        schedule: JOB_SCHEDULES[job].schedule,
        state: "unknown" as const,
        lastOk: null,
        ageMs: null,
        detail: null,
      })),
    };
  }

  const byName = new Map(entries.map((e) => [e.job, e]));

  const jobs: JobHealth[] = JOB_NAMES.map((job) => {
    const cfg = JOB_SCHEDULES[job];
    const entry = byName.get(job);
    const { state, ageMs } = stateFor(entry, cfg, nowMs);
    return {
      job,
      label: cfg.label,
      schedule: cfg.schedule,
      state,
      lastOk: entry?.lastOk ?? null,
      ageMs,
      detail: entry?.detail ?? null,
    };
  });

  const overall = jobs.every((j) => j.state === "ok") ? "ok" : "attention";
  return { overall, jobs };
}
