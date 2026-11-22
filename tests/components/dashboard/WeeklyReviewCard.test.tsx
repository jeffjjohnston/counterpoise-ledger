import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WeeklyReviewState } from "@/types";
import { notifyWeeklyReviewSettings } from "@/lib/weekly-review";
import { useBookRole } from "@/components/BookRoleProvider";
import { WeeklyReviewCard } from "@/components/dashboard/WeeklyReviewCard";

vi.mock("@/components/BookRoleProvider", () => ({ useBookRole: vi.fn() }));
vi.mock("@/lib/navigation", async () => {
  const { mockNavigation } = await import("@/tests/helpers/navigation");
  return mockNavigation();
});


const review = {
  id: 7, source: "schedule", periodStart: "2026-10-05", periodEnd: "2026-10-11", status: "complete",
  summary: "Costco was entered twice.", error: null, model: "claude-opus-5-5",
  startedAt: "2026-10-12T05:00:00Z", completedAt: "2026-10-12T05:01:00Z",
  items: [
    { id: 1, kind: "check", category: "duplicate", title: "Costco $142.10 twice", detail: "Two equal rows.", transactionIds: [10, 11], transactions: [{ id: 10, accountId: 3 }, { id: 11, accountId: null }], recurringRuleId: null, dismissedAt: null },
    { id: 2, kind: "insight", category: "spending_change", title: "Groceries up 30%", detail: "Above your average.", transactionIds: [], transactions: [], recurringRuleId: null, dismissedAt: null },
    { id: 3, kind: "check", category: "missed_payment", title: "Rent not seen", detail: "Expected on the 1st.", transactionIds: [], transactions: [], recurringRuleId: 4, dismissedAt: null },
  ],
} as const;

function state(overrides: Partial<WeeklyReviewState> = {}): WeeklyReviewState {
  return { configured: true, enabled: true, latest: review as unknown as WeeklyReviewState["latest"], running: null, lastFailure: null, ...overrides };
}

/** The state as the server gives it: a dismissed item is not in the list. */
function serverState(dismissed: Set<number>, overrides: Partial<WeeklyReviewState> = {}): WeeklyReviewState {
  const latest = { ...review, items: review.items.filter((item) => !dismissed.has(item.id)) };
  return state({ latest: latest as unknown as WeeklyReviewState["latest"], ...overrides });
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = handler(url, init);
    return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
  }));
  return calls;
}

describe("WeeklyReviewCard", () => {
  beforeEach(() => {
    vi.mocked(useBookRole).mockReturnValue({ canWrite: true } as ReturnType<typeof useBookRole>);
    localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("shows the period, the summary, check items and insights with links", async () => {
    mockFetch(() => state());
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByRole("heading", { name: /^Weekly review\s*·\s*Oct 5 – 11$/ })).toBeInTheDocument();
    expect(screen.getByText("Costco was entered twice.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Check" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Insights" })).toBeInTheDocument();
    // The register opens on the account first; without it, it jumps to the favorite account.
    expect(screen.getByRole("link", { name: /transaction 10/i })).toHaveAttribute("href", "/b/1/transactions?accountId=3&highlight=10");
    expect(screen.getByRole("link", { name: /transaction 11/i })).toHaveAttribute("href", "/b/1/transactions?highlight=11");
  });

  it("renders nothing when the server is not configured", async () => {
    mockFetch(() => state({ configured: false, enabled: false, latest: null }));
    const { container } = render(<WeeklyReviewCard bookId="1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("invites an editor to turn it on, and shows a viewer nothing", async () => {
    mockFetch(() => state({ enabled: false, latest: null }));
    const { unmount } = render(<WeeklyReviewCard bookId="1" />);
    // The link opens the Features section of the settings page.
    expect(await screen.findByRole("link", { name: /turn it on/i })).toHaveAttribute("href", "/b/1/settings#features");
    unmount();
    vi.mocked(useBookRole).mockReturnValue({ canWrite: false } as ReturnType<typeof useBookRole>);
    const { container } = render(<WeeklyReviewCard bookId="1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses an item and undoes it", async () => {
    const dismissed = new Set<number>();
    const calls = mockFetch((url) => {
      if (url.endsWith("/dismiss")) dismissed.add(1);
      if (url.endsWith("/restore")) dismissed.delete(1);
      return url.endsWith("/dismiss") || url.endsWith("/restore") ? review.items[0] : serverState(dismissed);
    });
    render(<WeeklyReviewCard bookId="1" />);
    fireEvent.click(await screen.findByRole("button", { name: /dismiss costco/i }));
    await waitFor(() => expect(screen.queryByText("Costco $142.10 twice")).not.toBeInTheDocument());
    expect(calls.some((call) => call.url === "/api/b/1/weekly-review/items/1/dismiss")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(screen.getByText("Costco $142.10 twice")).toBeInTheDocument());
    expect(calls.some((call) => call.url === "/api/b/1/weekly-review/items/1/restore")).toBe(true);
  });

  it("starts a review, shows Reviewing… and asks again until it ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let polls = 0;
    mockFetch((url, init) => {
      if (init?.method === "POST") return { id: 8 };
      polls += 1;
      return polls < 3 ? state({ running: { id: 8, periodStart: "2026-10-05", periodEnd: "2026-10-11", startedAt: "x" } }) : state();
    });
    render(<WeeklyReviewCard bookId="1" />);
    fireEvent.click(await screen.findByRole("button", { name: /review now/i }));
    expect(await screen.findByText(/reviewing/i)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await waitFor(() => expect(screen.queryByText(/reviewing/i)).not.toBeInTheDocument());
  });

  it("shows a failure with Try again", async () => {
    mockFetch(() => state({ latest: null, lastFailure: { id: 3, error: "refusal", completedAt: "x" } }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText("The model declined to review this week.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it.each([
    ["invalid_api_key", "Anthropic refused the server's API key. Ask the operator to check ANTHROPIC_API_KEY."],
    ["provider_unavailable", "Anthropic is busy or down. Try again later."],
  ])("shows the text of %s", async (error, text) => {
    mockFetch(() => state({ latest: null, lastFailure: { id: 3, error, completedAt: "x" } }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says when the first review runs", async () => {
    mockFetch(() => state({ latest: null }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText(/first review runs monday at 5:00/i)).toBeInTheDocument();
  });

  it("says Nothing to check when there are no items", async () => {
    mockFetch(() => state({ latest: { ...review, items: [] } as unknown as WeeklyReviewState["latest"] }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText(/nothing to check this week/i)).toBeInTheDocument();
  });

  it("can be hidden by the viewer", async () => {
    mockFetch(() => state());
    render(<WeeklyReviewCard bookId="1" />);
    fireEvent.click(await screen.findByRole("button", { name: /hide/i }));
    expect(screen.queryByText("Costco was entered twice.")).not.toBeInTheDocument();
    expect(localStorage.getItem("counterpoise.weeklyReview.1.hidden")).toBe("true");
  });
  it("links a rule item to that rule", async () => {
    mockFetch(() => state());
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByRole("link", { name: /recurring rule/i })).toHaveAttribute("href", "/b/1/recurring/4");
  });

  it("ignores a late answer for the book that was shown before", async () => {
    let releaseBookOne: (value: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const body = url.startsWith("/api/b/1/")
        ? new Promise((resolve) => { releaseBookOne = resolve; })
        : Promise.resolve(state({ latest: { ...review, summary: "Book two week." } as unknown as WeeklyReviewState["latest"] }));
      return Promise.resolve({ ok: true, status: 200, json: () => body, headers: new Headers() } as Response);
    }));
    const { rerender } = render(<WeeklyReviewCard bookId="1" />);
    rerender(<WeeklyReviewCard bookId="2" />);
    expect(await screen.findByText("Book two week.")).toBeInTheDocument();
    await act(async () => { releaseBookOne(state()); });
    expect(screen.queryByText("Costco was entered twice.")).not.toBeInTheDocument();
    expect(screen.getByText("Book two week.")).toBeInTheDocument();
  });

  it("loads again when the book settings change", async () => {
    let enabled = false;
    mockFetch(() => state({ enabled, latest: null }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByRole("link", { name: /turn it on/i })).toBeInTheDocument();
    enabled = true;
    act(() => { notifyWeeklyReviewSettings("1"); });
    expect(await screen.findByRole("button", { name: /review now/i })).toBeInTheDocument();
  });

  it("drops Undo when a newer review replaces the list", async () => {
    let current = state();
    mockFetch((url) => (url.endsWith("/dismiss") ? review.items[0] : current));
    render(<WeeklyReviewCard bookId="1" />);
    fireEvent.click(await screen.findByRole("button", { name: /dismiss costco/i }));
    expect(await screen.findByRole("button", { name: /undo/i })).toBeInTheDocument();
    current = state({ latest: { ...review, id: 8, items: [] } as unknown as WeeklyReviewState["latest"] });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument());
  });

  it("ignores a read that started before a dismissal", async () => {
    let release: (() => void) | null = null;
    let reads = 0;
    const dismissed = new Set<number>();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/dismiss")) dismissed.add(1);
      // The deferred read is a snapshot from before the dismissal.
      const body = url.endsWith("/dismiss") ? review.items[0] : reads === 1 ? serverState(new Set()) : serverState(dismissed);
      if (!url.endsWith("/dismiss")) {
        reads += 1;
        // The second read (on window focus) answers only after the dismissal.
        if (reads === 2) await new Promise<void>((resolve) => { release = resolve; });
      }
      return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
    }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText("Costco $142.10 twice")).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Costco $142.10 twice" }));
    await waitFor(() => expect(screen.queryByText("Costco $142.10 twice")).toBeNull());
    await act(async () => { release?.(); await Promise.resolve(); });
    expect(screen.queryByText("Costco $142.10 twice")).toBeNull();
  });

  it("shows a run that Review now started, also after a dismissal during the start", async () => {
    let started = false;
    let release: (() => void) | null = null;
    const dismissed = new Set<number>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/dismiss")) dismissed.add(1);
      let body: unknown = started
        ? serverState(dismissed, { running: { id: 9, periodStart: "2026-10-05", periodEnd: "2026-10-11", startedAt: "x" } })
        : serverState(dismissed);
      if (url.endsWith("/run")) {
        started = true;
        body = { id: 9 };
      } else if (url.endsWith("/dismiss")) {
        body = review.items[0];
      } else if (started && init?.method !== "POST" && release === null) {
        // The read after the start answers only after the dismissal.
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
    }));
    render(<WeeklyReviewCard bookId="1" />);
    expect(await screen.findByText("Costco $142.10 twice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review now" }));
    await waitFor(() => expect(release).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Costco $142.10 twice" }));
    await waitFor(() => expect(screen.queryByText("Costco $142.10 twice")).toBeNull());
    await act(async () => { release?.(); await Promise.resolve(); });
    expect(await screen.findByRole("status")).toHaveTextContent(/reviewing/i);
  });
});
