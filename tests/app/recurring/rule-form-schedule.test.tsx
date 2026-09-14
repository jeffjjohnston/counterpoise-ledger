import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecurringRuleDetailPage from "@/app/b/[bookId]/recurring/[id]/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ bookId: "1", id: "7" }),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

const accountPayload = [
  {
    id: 1,
    name: "Rewards Credit Card",
    type: "liability",
    subtype: "credit_card",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
  },
  {
    id: 2,
    name: "Subscription Fees",
    type: "expense",
    subtype: "other",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
  },
];

// Weekly, every 4 weeks, with no explicit days of week — the shape whose
// stored nextDate an unrelated edit used to re-anchor onto the start date.
const everyFourWeeksRule = {
  id: 7,
  name: "Streaming Service",
  frequency: "weekly",
  interval: 4,
  daysOfWeek: null,
  weekOfMonth: null,
  daysOfMonth: null,
  startDate: "2025-04-01",
  endDate: null,
  nextDate: "2026-09-15",
  autoCreateDaysBefore: 5,
  businessDaysOnly: false,
  templateDescription: "Streaming Service",
  payeeId: null,
  payee: null,
  isActive: true,
  createdAt: "2025-04-01T00:00:00.000Z",
  templateSplits: [
    { id: 1, recurringRuleId: 7, accountId: 1, amount: -1200, account: accountPayload[0] },
    { id: 2, recurringRuleId: 7, accountId: 2, amount: 1200, account: accountPayload[1] },
  ],
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/b/1/recurring/7" && init?.method === "PUT") {
      return { ok: true, json: async () => everyFourWeeksRule } as Response;
    }
    // The detail page's own read of the rule it is about to edit.
    if (url === "/api/b/1/recurring/7") {
      return { ok: true, json: async () => everyFourWeeksRule } as Response;
    }
    if (url === "/api/b/1/recurring") {
      return { ok: true, json: async () => [everyFourWeeksRule] } as Response;
    }
    if (url.startsWith("/api/b/1/accounts")) {
      return { ok: true, json: async () => accountPayload } as Response;
    }
    if (url.startsWith("/api/b/1/payees")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/transactions")) {
      return {
        ok: true,
        json: async () => ({ transactions: [], totalCount: 0 }),
      } as Response;
    }
    return { ok: true, json: async () => [] } as Response;
  });
}

// The form is reached from the rule DETAIL page: the list page's rows no
// longer carry an Edit button. Only the route into the form moved — every
// assertion below is about the form itself and is unchanged.
async function openEditModal() {
  render(<RecurringRuleDetailPage />);
  const editButton = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(editButton);
  return within(await screen.findByTestId("modal"));
}

describe("recurring rule form — weekly schedule", () => {
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the repeat interval of an every-4-weeks rule", async () => {
    const modal = await openEditModal();
    const interval = await modal.findByLabelText(/repeat every/i);
    expect((interval as HTMLInputElement).value).toBe("4");
  });

  it("keeps interval 4 when an every-4-weeks rule is saved unchanged", async () => {
    const modal = await openEditModal();

    fireEvent.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.interval).toBe(4);
    });
  });

  it("does not label a week-of-month option as an N-week cadence", async () => {
    const modal = await openEditModal();
    const pattern = modal.getByLabelText("Which weeks");
    const labels = Array.from(pattern.querySelectorAll("option")).map((o) => o.textContent);

    expect(labels).not.toContain("Every 4th week");
    expect(labels).toContain("4th week of each month");
  });

  it("states the schedule the rule already runs on", async () => {
    // The form asked for four to six controls and rendered no output, which is
    // why every schedule defect fixed alongside this summary was invisible here
    // and plain in the rule list one screen away.
    const modal = await openEditModal();

    const summary = await modal.findByTestId("schedule-summary");
    expect(summary).toHaveTextContent("Every 4 weeks");
    expect((modal.getByLabelText("Next occurrence") as HTMLInputElement).value).toBe(
      "2026-09-15"
    );
  });

  it("restates the schedule when a control changes", async () => {
    const modal = await openEditModal();
    await modal.findByTestId("schedule-summary");

    fireEvent.change(await modal.findByLabelText(/repeat every/i), {
      target: { value: "1" },
    });

    // The stored nextDate only survives an edit that leaves the schedule
    // alone, so dropping to every week must re-derive from the start date
    // rather than keep showing Sep 15.
    await waitFor(() => {
      expect(modal.getByTestId("schedule-summary")).toHaveTextContent("Weekly");
      expect((modal.getByLabelText("Next occurrence") as HTMLInputElement).value).toBe(
        "2026-09-01"
      );
    });
  });

  it("sends the next occurrence when it has been set by hand", async () => {
    // The request that started all this: "make this one fire four weeks from
    // today". updateRuleSchema has always accepted nextDate and
    // updateRecurringRule skips its recompute when one is supplied — the form
    // was the only surface that could not say it.
    const modal = await openEditModal();

    fireEvent.change(await modal.findByLabelText("Next occurrence"), {
      target: { value: "2026-09-24" },
    });
    fireEvent.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      expect(JSON.parse((put![1] as RequestInit).body as string).nextDate).toBe(
        "2026-09-24"
      );
    });
  });

  it("omits nextDate when the field was never touched", async () => {
    // Sending it unconditionally would suppress the server-side recompute on
    // every save, so a schedule change would leave the old date standing.
    const modal = await openEditModal();
    await modal.findByLabelText("Next occurrence");

    fireEvent.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      expect(JSON.parse((put![1] as RequestInit).body as string)).not.toHaveProperty(
        "nextDate"
      );
    });
  });

  it("lets a monthly rule repeat on an arbitrary interval", async () => {
    // Monthly used to offer MONTHLY_INTERVAL_OPTIONS, six fixed presets, so
    // every 7 months was unreachable even though getNextDate implements it.
    const modal = await openEditModal();

    fireEvent.change(modal.getByLabelText("Frequency"), { target: { value: "monthly" } });
    fireEvent.change(await modal.findByLabelText("Repeat every"), { target: { value: "7" } });
    fireEvent.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.frequency).toBe("monthly");
      expect(body.interval).toBe(7);
    });
  });

  it("gives a yearly rule an interval control at all", async () => {
    // Yearly rendered no interval control, so its interval could only ever
    // stay whatever it already was.
    const modal = await openEditModal();

    fireEvent.change(modal.getByLabelText("Frequency"), { target: { value: "yearly" } });
    fireEvent.change(await modal.findByLabelText("Repeat every"), { target: { value: "2" } });
    fireEvent.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.frequency).toBe("yearly");
      expect(body.interval).toBe(2);
    });
  });

  it("drops the Month Pattern preset in favour of the shared interval", async () => {
    const modal = await openEditModal();

    fireEvent.change(modal.getByLabelText("Frequency"), { target: { value: "monthly" } });

    await modal.findByText("Days of Month");
    expect(modal.queryByLabelText("Month Pattern")).toBeNull();
  });

  it("keeps the year on preview dates that span years", async () => {
    // formatDateShort drops the year, so a yearly rule previewed as
    // "then Apr 1 · Apr 1" — three distinct years rendered identically.
    const modal = await openEditModal();

    fireEvent.change(modal.getByLabelText("Frequency"), { target: { value: "yearly" } });

    await waitFor(() => {
      const summary = modal.getByTestId("schedule-summary");
      expect(summary).toHaveTextContent("Apr 1, 2028");
      expect(summary).toHaveTextContent("Apr 1, 2029");
    });
  });

  it("groups the form under headings", async () => {
    const modal = await openEditModal();

    expect(modal.getByRole("heading", { name: "What it is" })).toBeInTheDocument();
    expect(modal.getByRole("heading", { name: "When it runs" })).toBeInTheDocument();
    expect(modal.getByRole("heading", { name: "What it posts" })).toBeInTheDocument();
  });

  it("keeps the rarely-used settings behind a closed Advanced disclosure", async () => {
    // Auto-create and business-days-only sat mid-form at full weight, in the
    // path of every routine edit, and pushed Save Changes below the fold.
    const modal = await openEditModal();

    expect(modal.queryByLabelText("Business days only")).toBeNull();
    expect(modal.queryByLabelText("Anchor date")).toBeNull();

    fireEvent.click(modal.getByRole("button", { name: /advanced/i }));

    expect(await modal.findByLabelText("Business days only")).toBeInTheDocument();
    expect(modal.getByLabelText("Anchor date")).toBeInTheDocument();
  });

  it("gives the day toggles an accessible group name", async () => {
    // The group labels were bare <label> elements with no associated control,
    // so a screen reader got no name for the grid of toggles.
    const modal = await openEditModal();

    expect(modal.getByRole("group", { name: "Days of Week" })).toBeInTheDocument();
  });
});
