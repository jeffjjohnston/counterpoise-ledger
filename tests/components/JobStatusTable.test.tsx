import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobStatusTable } from "@/components/system/JobStatusTable";
import type { JobHealth } from "@/lib/job-health";

function job(over: Partial<JobHealth> & { job: string }): JobHealth {
  return {
    label: over.job,
    schedule: "Hourly",
    state: "ok",
    lastOk: new Date().toISOString(),
    ageMs: 0,
    detail: null,
    ...over,
  } as JobHealth;
}

function healthyPayload() {
  return {
    overall: "ok",
    jobs: [
      job({ job: "backup", label: "Database backup", schedule: "Hourly, 6am–9pm" }),
      job({ job: "recurring", label: "Recurring transactions", schedule: "Hourly" }),
      job({ job: "plaid-sync", label: "Bank sync", schedule: "Every 6h" }),
      job({ job: "price-sync", label: "Security prices", schedule: "Tue–Sat 6am" }),
      job({ job: "prune", label: "Backup pruning", schedule: "Daily 4am" }),
      job({ job: "reindex", label: "Reindex", schedule: "Monthly, 1st 3am" }),
    ],
  };
}

function mockStatus(body: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("JobStatusTable", () => {
  it("renders every monitored job even when all are healthy", async () => {
    // The navbar indicator filters to unhealthy jobs. This surface must not:
    // it exists to answer "what is monitored?", which needs the healthy ones.
    mockStatus(healthyPayload());

    render(<JobStatusTable />);

    expect(await screen.findByText("Database backup")).toBeInTheDocument();
    for (const label of [
      "Recurring transactions",
      "Bank sync",
      "Security prices",
      "Backup pruning",
      "Reindex",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders each job's schedule label", async () => {
    mockStatus(healthyPayload());

    render(<JobStatusTable />);

    expect(await screen.findByText("Tue–Sat 6am")).toBeInTheDocument();
    expect(screen.getByText("Every 6h")).toBeInTheDocument();
    expect(screen.getByText("Monthly, 1st 3am")).toBeInTheDocument();
  });

  it("renders a relative last-success time", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    mockStatus({
      overall: "ok",
      jobs: [job({ job: "backup", label: "Database backup", lastOk: threeHoursAgo })],
    });

    render(<JobStatusTable />);

    expect(await screen.findByText("3 hr ago")).toBeInTheDocument();
  });

  it("renders a dash rather than a date when a job has never succeeded", async () => {
    mockStatus({
      overall: "attention",
      jobs: [
        job({ job: "backup", label: "Database backup", state: "missing", lastOk: null }),
      ],
    });

    render(<JobStatusTable />);

    await screen.findByText("Database backup");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders a dash rather than NaN for an unparseable timestamp", async () => {
    mockStatus({
      overall: "ok",
      jobs: [job({ job: "backup", label: "Database backup", lastOk: "not-a-date" })],
    });

    render(<JobStatusTable />);

    await screen.findByText("Database backup");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows all six jobs as unknown when no status directory is mounted", async () => {
    // Local dev. Unlike the navbar indicator, this table stays visible — an
    // informational board admitting it has no data, not a false alarm.
    mockStatus({
      overall: "unknown",
      jobs: healthyPayload().jobs.map((j) => ({
        ...j,
        state: "unknown",
        lastOk: null,
        ageMs: null,
      })),
    });

    render(<JobStatusTable />);

    expect(await screen.findByText("Database backup")).toBeInTheDocument();
    expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(6);
  });

  it("surfaces a broken monitoring path instead of looking like local dev", async () => {
    // An unreadable status directory returns all-unknown jobs — byte-identical
    // to the local-dev payload except for this string.
    mockStatus({
      overall: "attention",
      jobs: [],
      error: "Status directory unreadable (EACCES)",
    });

    render(<JobStatusTable />);

    expect(
      await screen.findByText("Status directory unreadable (EACCES)")
    ).toBeInTheDocument();
  });

  it("renders a job's detail text", async () => {
    mockStatus({
      overall: "attention",
      jobs: [
        job({
          job: "backup",
          label: "Database backup",
          state: "unverified",
          detail: "dump unreadable by pg_restore",
        }),
      ],
    });

    render(<JobStatusTable />);

    expect(
      await screen.findByText("dump unreadable by pg_restore")
    ).toBeInTheDocument();
  });

  it("suppresses the detail of a healthy job", async () => {
    // The crontab records a detail on success too: `recurring`, `plaid-sync`
    // and `price-sync` all write "HTTP 200". Rendering it unconditionally puts
    // a subtitle saying nothing under half the rows in production.
    mockStatus({
      overall: "ok",
      jobs: [
        job({
          job: "recurring",
          label: "Recurring transactions",
          state: "ok",
          detail: "HTTP 200",
        }),
      ],
    });

    render(<JobStatusTable />);

    await screen.findByText("Recurring transactions");
    expect(screen.queryByText("HTTP 200")).not.toBeInTheDocument();
  });

  it("falls back to the six job names when the fetch rejects", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    render(<JobStatusTable />);

    expect(await screen.findByText("Database backup")).toBeInTheDocument();
    expect(screen.getByText("Security prices")).toBeInTheDocument();
  });

  it("falls back to the six job names on a non-2xx response", async () => {
    // Includes the expired-session 401. Blanking the section would be worse
    // than admitting we do not know.
    mockStatus({ error: "Not authenticated" }, false);

    render(<JobStatusTable />);

    expect(await screen.findByText("Database backup")).toBeInTheDocument();
  });

  it("surfaces an error message when the fetch rejects", async () => {
    // A rejected fetch (network failure, timeout, or a broken monitoring
    // endpoint) must not render identically to ordinary local dev, which also
    // has no ./backups mount and also falls back to all-unknown rows. The
    // error line is what tells the two apart.
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    render(<JobStatusTable />);

    expect(
      await screen.findByText("Could not load job status")
    ).toBeInTheDocument();
  });

  it("passes an abort signal so the request cannot hang forever", async () => {
    // A stalled ./backups mount would otherwise hang readdir/readFile
    // server-side, leaving the fetch promise unsettled and the skeleton
    // spinning indefinitely. Asserting the signal is present is sufficient
    // coverage here; exercising the 10s expiry itself is not worth the
    // fake-timer complexity.
    mockStatus(healthyPayload());

    render(<JobStatusTable />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("shows the overall state even when everything is healthy", async () => {
    // A badge that appears only on trouble would reintroduce the indicator's
    // alarm semantics on a surface that is not an alarm.
    //
    // Queried by role, not aria-label text: a bare <span> maps to
    // role=generic, which prohibits an author-supplied accessible name, so
    // findByLabelText would pass even if the role were wrong — Testing
    // Library computes the name from the attribute regardless of whether the
    // role supports naming. Querying by role fails if role="img" is removed,
    // which is the point.
    mockStatus(healthyPayload());

    render(<JobStatusTable />);

    expect(
      await screen.findByRole("img", { name: "Overall status: ok" })
    ).toBeInTheDocument();
  });

  it("refetches on an interval so a long-open tab stays current", async () => {
    // A tab left open on the book listing page has no navbar counterpart
    // (JobHealthIndicator isn't mounted here) to keep it current, so this
    // component must poll on its own.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mockStatus(healthyPayload());

    render(<JobStatusTable />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    vi.advanceTimersByTime(5 * 60_000);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    vi.useRealTimers();
  });

  it("refetches when the tab becomes visible and renders the newly-returned state", async () => {
    const staleJob = job({
      job: "backup",
      label: "Database backup",
      state: "stale",
      detail: null,
    });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ overall: "attention", jobs: [staleJob] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          overall: "ok",
          jobs: [job({ job: "backup", label: "Database backup", state: "ok" })],
        }),
      }) as unknown as typeof fetch;

    render(<JobStatusTable />);
    expect(
      await screen.findByRole("img", { name: "Overall status: attention" })
    ).toBeInTheDocument();

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Overall status: ok" })
      ).toBeInTheDocument()
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("still renders the error state correctly after a failed refresh", async () => {
    // Healthy first, then a broken refresh — the error line must appear on
    // the second fetch just as it would on the first.
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => healthyPayload(),
      })
      .mockRejectedValueOnce(new Error("offline")) as unknown as typeof fetch;

    render(<JobStatusTable />);
    expect(
      await screen.findByRole("img", { name: "Overall status: ok" })
    ).toBeInTheDocument();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(
      await screen.findByText("Could not load job status")
    ).toBeInTheDocument();
    // The six-job fallback board is still there, not a blanked section.
    expect(screen.getByText("Database backup")).toBeInTheDocument();
  });

  it("ignores a stale response that resolves after a newer one", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    global.fetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          overall: "attention",
          jobs: [job({ job: "backup", label: "Database backup", state: "stale" })],
        }),
      }) as unknown as typeof fetch;

    render(<JobStatusTable />);
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("img", { name: "Overall status: attention" })
    ).toBeInTheDocument();

    // The original slow request finally lands, reporting everything healthy.
    // It must not overwrite the newer "attention" state above.
    resolveFirst({
      ok: true,
      status: 200,
      json: async () => healthyPayload(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      screen.getByRole("img", { name: "Overall status: attention" })
    ).toBeInTheDocument();
  });
});
