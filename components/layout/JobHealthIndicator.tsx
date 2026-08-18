"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api-client";
import type { JobHealth } from "@/lib/job-health";

type StatusResponse = {
  overall: "ok" | "attention" | "unknown";
  jobs: JobHealth[];
  error?: string;
};

/** Status changes hourly at most, so a slow poll is plenty. */
const REFRESH_MS = 5 * 60_000;

/**
 * Navbar indicator for scheduled job health. Silent unless something needs
 * attention — an ops widget that is always visible becomes wallpaper, and this
 * one has to still mean something the day a backup quietly stops.
 *
 * "unknown" (no ./backups mount, i.e. local dev) renders nothing: a warning on
 * every dev session trains the warning away before it ever fires for real.
 */
export function JobHealthIndicator({ className }: { className?: string }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;

    const load = () => {
      const seq = ++latest;
      apiGet<StatusResponse>("/api/system/status")
        .then((body) => {
          // Apply only a successful, still-current response. Clearing state on
          // a transient 500 or an expired session would make an active warning
          // vanish, and a slow earlier request landing last would overwrite a
          // newer one — both are the alarm switching itself off, which is the
          // failure this whole feature exists to prevent.
          if (!cancelled && body && seq === latest) setStatus(body);
        })
        .catch(() => {
          // Stay silent: a failed status fetch is not itself an alarm.
        });
    };

    load();

    // BookNavbar lives in the persistent book layout, so without these a tab
    // left open for days would show whatever was true when it was opened —
    // never noticing a job that broke since, and never clearing one that
    // recovered.
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!status || status.overall !== "attention") return null;

  const unhealthy = status.jobs.filter(
    (j) => j.state !== "ok" && j.state !== "unknown"
  );

  // One phrase for both the visible label and the accessible name, so they
  // cannot disagree about pluralisation.
  const summary = status.error
    ? "Job status unavailable"
    : `${unhealthy.length} job${unhealthy.length === 1 ? "" : "s"} ` +
      `need${unhealthy.length === 1 ? "s" : ""} attention`;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
      >
        <span aria-hidden>●</span>
        {summary}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Scheduled job health"
          className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {status.error && (
            <p className="mb-2 text-sm text-amber-600 dark:text-amber-400">
              {status.error}
            </p>
          )}
          <ul className="space-y-1.5 text-sm">
            {unhealthy.map((job) => (
              <li key={job.job} className="flex justify-between gap-3">
                <span className="text-neutral-700 dark:text-neutral-200">
                  {job.label}
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  {job.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
