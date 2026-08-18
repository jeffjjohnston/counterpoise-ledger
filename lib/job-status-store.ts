import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobEntry } from "@/lib/job-health";

function statusDir(): string {
  return process.env.STATUS_DIR ?? "/backups/status";
}

/** The status directory exists but cannot be read — a monitoring-path fault. */
export class JobStatusUnreadableError extends Error {
  constructor(readonly code: string) {
    super(`Status directory unreadable (${code})`);
    this.name = "JobStatusUnreadableError";
  }
}

/**
 * Returns null only when the status directory genuinely does not exist — the
 * local dev case with no ./backups mount, which must read as "unknown" rather
 * than a fault.
 *
 * Any other readdir failure (EACCES, EIO, ENOTDIR) is a break in the monitoring
 * path itself and throws. Mapping those to null too would render them as
 * "unknown", which the indicator suppresses — silently hiding the failure of
 * the thing whose whole job is to stop failures being silent.
 *
 * A single unparseable file is still skipped, so one bad write cannot blind the
 * whole surface; that job then reports "missing", which is visible and accurate.
 */
export async function readJobEntries(): Promise<JobEntry[] | null> {
  let names: string[];
  try {
    // turbopackIgnore: the directory is a runtime mount chosen by env, so
    // Turbopack cannot resolve it statically and would otherwise trace the
    // entire project — source and public/ included — into the standalone
    // output.
    names = await readdir(/* turbopackIgnore: true */ statusDir());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return null;
    throw new JobStatusUnreadableError(code);
  }

  const entries: JobEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const raw = await readFile(
        join(/* turbopackIgnore: true */ statusDir(), name),
        "utf8"
      );
      const parsed = JSON.parse(raw) as JobEntry;
      if (parsed && typeof parsed.job === "string") entries.push(parsed);
    } catch {
      // Skip unparseable or vanished files.
    }
  }
  return entries;
}
