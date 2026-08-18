import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobHealthIndicator } from "@/components/layout/JobHealthIndicator";

function mockStatus(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("JobHealthIndicator", () => {
  it("renders nothing when everything is healthy", async () => {
    mockStatus({ overall: "ok", jobs: [] });

    const { container } = render(<JobHealthIndicator />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when status is unknown (local dev, no mount)", async () => {
    mockStatus({ overall: "unknown", jobs: [] });

    const { container } = render(<JobHealthIndicator />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an indicator naming the unhealthy job count", async () => {
    mockStatus({
      overall: "attention",
      jobs: [
        {
          job: "backup",
          label: "Database backup",
          state: "stale",
          lastOk: null,
          ageMs: null,
          detail: null,
        },
        {
          job: "prune",
          label: "Backup pruning",
          state: "ok",
          lastOk: null,
          ageMs: null,
          detail: null,
        },
      ],
    });

    render(<JobHealthIndicator />);

    expect(
      await screen.findByRole("button", { name: /1 job needs attention/i })
    ).toBeInTheDocument();
  });

  it("pluralizes label and accessible name identically", async () => {
    const job = (name: string) => ({
      job: name,
      label: name,
      state: "stale",
      lastOk: null,
      ageMs: null,
      detail: null,
    });
    mockStatus({ overall: "attention", jobs: [job("a"), job("b")] });

    render(<JobHealthIndicator />);

    const button = await screen.findByRole("button", {
      name: /2 jobs need attention/i,
    });
    expect(button).toHaveAccessibleName("2 jobs need attention");
    expect(button).toHaveTextContent("2 jobs need attention");
  });

  it("refetches on an interval so a long-open tab stays current", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mockStatus({ overall: "ok", jobs: [] });

    render(<JobHealthIndicator />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    vi.advanceTimersByTime(5 * 60_000);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    vi.useRealTimers();
  });

  it("surfaces a broken monitoring path instead of hiding it", async () => {
    mockStatus({
      overall: "attention",
      jobs: [],
      error: "Status directory unreadable (EACCES)",
    });

    render(<JobHealthIndicator />);

    expect(
      await screen.findByRole("button", { name: /job status unavailable/i })
    ).toBeInTheDocument();
  });

  const staleJob = {
    job: "backup",
    label: "Database backup",
    state: "stale",
    lastOk: null,
    ageMs: null,
    detail: null,
  };
  const attention = { overall: "attention", jobs: [staleJob] };

  it("keeps an existing warning when a later refresh errors", async () => {
    // An alarm that switches itself off on a transient 500 or an expired
    // session is the exact failure this feature exists to prevent.
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => attention })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) as never;

    render(<JobHealthIndicator />);
    await screen.findByRole("button", { name: /1 job needs attention/i });

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    expect(
      screen.getByRole("button", { name: /1 job needs attention/i })
    ).toBeInTheDocument();
  });

  it("ignores a stale response that resolves after a newer one", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    global.fetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok: true, json: async () => attention }) as never;

    render(<JobHealthIndicator />);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: /1 job needs attention/i });

    // The original slow request finally lands, reporting everything healthy.
    resolveFirst({ ok: true, json: async () => ({ overall: "ok", jobs: [] }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      screen.getByRole("button", { name: /1 job needs attention/i })
    ).toBeInTheDocument();
  });

  it("exposes popover semantics matching PriceEntryPill", async () => {
    mockStatus(attention);

    render(<JobHealthIndicator />);
    const button = await screen.findByRole("button", {
      name: /1 job needs attention/i,
    });

    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");

    button.click();

    await waitFor(() =>
      expect(button).toHaveAttribute("aria-expanded", "true")
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Scheduled job health"
    );
  });

  it("stays silent when the request fails", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    const { container } = render(<JobHealthIndicator />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
