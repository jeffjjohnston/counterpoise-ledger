"use client";

import { useEffect, useState } from "react";
import { formatRelativeAge } from "@/lib/formatters";
import { apiGet } from "@/lib/api-client";
import {
  evaluateJobHealth,
  type JobHealth,
  type JobState,
} from "@/lib/job-health";

type Overall = "ok" | "attention" | "unknown";

type StatusResponse = {
  overall: Overall;
  jobs: JobHealth[];
  error?: string;
};

/**
 * `unknown` is muted rather than coloured: on this page it means "no status
 * directory mounted", which is the normal local-dev state and not a problem.
 * Colouring it would make every dev session look like an incident.
 */
const STATE_DOT: Record<JobState, string> = {
  ok: "text-fg-success",
  stale: "text-fg-warning",
  unverified: "text-fg-warning",
  failed: "text-fg-danger",
  missing: "text-fg-danger",
  unknown: "text-fg-tertiary",
};

const OVERALL_BADGE: Record<Overall, string> = {
  ok: "bg-success-subtle text-fg-success",
  attention: "bg-warning-subtle text-fg-warning",
  unknown: "bg-surface-tertiary text-fg-tertiary",
};

/**
 * Matches JobHealthIndicator's REFRESH_MS (components/layout/JobHealthIndicator.tsx),
 * which isn't exported. Status changes hourly at most, so a slow poll is
 * plenty — the two surfaces are meant to stay in lockstep.
 */
const REFRESH_MS = 5 * 60_000;

/**
 * Derived from `lastOk` at render time rather than from the server's `ageMs`,
 * which is a snapshot taken when the request was served. This page never
 * refetches, so a tab left open all afternoon would otherwise keep insisting
 * the backup ran "14 min ago".
 */
function lastSuccess(lastOk: string | null): string {
  if (!lastOk) return "—";
  return formatRelativeAge(Date.now() - Date.parse(lastOk));
}

/**
 * Read-only status board for the scheduled jobs, on the book listing page.
 *
 * Unlike JobHealthIndicator — an alarm that stays silent unless something is
 * wrong — this always renders every monitored job, healthy and `unknown` ones
 * included. It answers "what is monitored, and when did each last work?", which
 * nothing else in the app answers: the indicator only ever lists what is
 * currently broken, and it is not mounted on this page at all.
 */
export function JobStatusTable() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Bumped on every fetch kicked off below; a response is only applied if
    // it's still the most recent one requested. Without this, a slow first
    // response landing after a newer poll or visibility refetch could
    // overwrite fresher state with stale data.
    let latest = 0;

    const load = () => {
      const seq = ++latest;

      apiGet<StatusResponse>("/api/system/status", { signal: AbortSignal.timeout(10_000) })
        .then((body) => {
          if (!cancelled && seq === latest) setStatus(body);
        })
        .catch(() => {
          // A failed, timed-out, or non-2xx request means we do not know the
          // state — precisely what the absent-directory evaluation already
          // expresses. Reusing it keeps the six job names on screen instead of
          // blanking the section or spinning the skeleton forever. But unlike a
          // missing status directory, this outcome also carries an error
          // string: a broken monitoring endpoint would otherwise render
          // byte-identical to ordinary local dev, which has no `./backups`
          // mount either. `overall` stays "unknown" rather than "attention" —
          // a failed browser fetch may be the client's own network, not a
          // server-side fault, so the error line carries the signal instead of
          // the badge.
          if (!cancelled && seq === latest) {
            setStatus({
              ...evaluateJobHealth(null, new Date()),
              error: "Could not load job status",
            });
          }
        });
    };

    load();

    // Unlike JobHealthIndicator, this table has no navbar counterpart
    // mounted on this page to keep it current — a tab left open on the book
    // listing page would otherwise keep reporting whatever was true when it
    // was opened, never noticing a job that failed since, and never clearing
    // the "last success" label's staleness or a job that recovered.
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

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-fg">Scheduled Jobs</h2>
        {status && (
          // Labelled, because a bare "ok" chip beside a heading tells a screen
          // reader nothing about what is ok. `role="img"` is required for the
          // `aria-label` to take effect: a bare <span> maps to role=generic,
          // which prohibits an author-supplied accessible name, so several
          // screen readers would otherwise ignore the label entirely.
          <span
            role="img"
            aria-label={`Overall status: ${status.overall}`}
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${OVERALL_BADGE[status.overall]}`}
          >
            {status.overall}
          </span>
        )}
      </div>

      {status?.error && (
        <p className="mb-3 text-sm text-fg-warning">{status.error}</p>
      )}

      {!status ? (
        <div className="animate-pulse space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="text-left font-medium text-fg-tertiary px-4 py-2">
                  Job
                </th>
                <th scope="col" className="text-left font-medium text-fg-tertiary px-4 py-2">
                  Schedule
                </th>
                <th scope="col" className="text-left font-medium text-fg-tertiary px-4 py-2">
                  Status
                </th>
                <th scope="col" className="text-left font-medium text-fg-tertiary px-4 py-2">
                  Last success
                </th>
              </tr>
            </thead>
            <tbody>
              {status.jobs.map((job) => (
                <tr key={job.job} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 text-fg">
                    {job.label}
                    {job.detail && job.state !== "ok" && (
                      // Suppressed for healthy jobs on purpose. The crontab
                      // records a detail on success too — `recurring`,
                      // `plaid-sync` and `price-sync` all write "HTTP 200" —
                      // so rendering it unconditionally puts a subtitle
                      // saying nothing under half the table. Detail earns its
                      // place only when it explains a state you have to act
                      // on.
                      <span className="block text-xs text-fg-tertiary">
                        {job.detail}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-fg-tertiary whitespace-nowrap">
                    {job.schedule}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className={STATE_DOT[job.state]} aria-hidden>
                      ●
                    </span>{" "}
                    <span className="text-fg-secondary">{job.state}</span>
                  </td>
                  <td className="px-4 py-2 text-fg-secondary whitespace-nowrap">
                    {lastSuccess(job.lastOk)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
