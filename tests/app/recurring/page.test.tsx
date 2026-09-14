import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecurringPage from "@/app/b/[bookId]/recurring/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    isOpen,
    children,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
  }) => (isOpen ? <div data-testid="modal">{children}</div> : null),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const accountPayload = [
  {
    id: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
  },
  {
    id: 2,
    name: "Rent",
    type: "expense",
    subtype: "other",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
  },
];

const longRuleName = "Very Long Recurring Transaction Name For Truncation";

const recurringPayload = [
  {
    id: 1,
    name: longRuleName,
    frequency: "weekly",
    interval: 1,
    daysOfWeek: "[1]",
    weekOfMonth: "every",
    daysOfMonth: null,
    startDate: "2026-02-01",
    endDate: null,
    nextDate: "2026-02-09",
    autoCreateDaysBefore: 0,
    templateDescription: "Long rule template",
    payeeId: null,
    payee: null,
    isActive: true,
    createdAt: "2026-02-01T00:00:00.000Z",
    templateSplits: [
      {
        id: 11,
        recurringRuleId: 1,
        accountId: 1,
        amount: 1000,
        account: accountPayload[0],
      },
      {
        id: 12,
        recurringRuleId: 1,
        accountId: 2,
        amount: -1000,
        account: accountPayload[1],
      },
    ],
  },
  {
    id: 2,
    name: "Friday Catchup Rule",
    frequency: "weekly",
    interval: 1,
    daysOfWeek: "[5]",
    weekOfMonth: "every",
    daysOfMonth: null,
    startDate: "2026-01-01",
    endDate: null,
    nextDate: "2026-02-06",
    autoCreateDaysBefore: 0,
    templateDescription: "Friday template",
    payeeId: null,
    payee: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    templateSplits: [
      {
        id: 21,
        recurringRuleId: 2,
        accountId: 1,
        amount: 500,
        account: accountPayload[0],
      },
      {
        id: 22,
        recurringRuleId: 2,
        accountId: 2,
        amount: -500,
        account: accountPayload[1],
      },
    ],
  },
  {
    id: 3,
    name: "Inactive Calendar Rule",
    frequency: "daily",
    interval: 1,
    daysOfWeek: null,
    weekOfMonth: null,
    daysOfMonth: null,
    startDate: "2026-02-01",
    endDate: null,
    nextDate: "2026-02-11",
    autoCreateDaysBefore: 0,
    templateDescription: "Inactive template",
    payeeId: null,
    payee: null,
    isActive: false,
    createdAt: "2026-01-20T00:00:00.000Z",
    templateSplits: [
      {
        id: 31,
        recurringRuleId: 3,
        accountId: 1,
        amount: 800,
        account: accountPayload[0],
      },
      {
        id: 32,
        recurringRuleId: 3,
        accountId: 2,
        amount: -800,
        account: accountPayload[1],
      },
    ],
  },
];

describe("RecurringPage calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-08T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a 4-week calendar with recurring pills and full-name hover title", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return {
          ok: true,
          json: async () => recurringPayload,
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountPayload,
        } as Response;
      }

      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    await waitFor(() => {
      expect(screen.getByText("Recurring Transactions")).toBeInTheDocument();
    });

    const calendar = screen.getByTestId("recurring-calendar");
    expect(within(calendar).getAllByTestId("calendar-week-row")).toHaveLength(4);

    const mondayCell = screen.getByTestId("calendar-day-cell-2026-02-09");
    const mondayPill = within(mondayCell).getByText(longRuleName);
    expect(mondayPill).toHaveAttribute("title", longRuleName);
    expect(mondayPill).toHaveClass("truncate");

    const fridayCell = screen.getByTestId("calendar-day-cell-2026-02-13");
    expect(within(fridayCell).getByText("Friday Catchup Rule")).toBeInTheDocument();

    const inactiveCell = screen.getByTestId("calendar-day-cell-2026-02-11");
    expect(within(inactiveCell).queryByText("Inactive Calendar Rule")).not.toBeInTheDocument();
  });

  it("allows a daily interval up to four years and clamps larger values", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => recurringPayload } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }

      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      if (url.startsWith("/api/b/1/payees")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    await waitFor(() => {
      expect(screen.getByText("Recurring Transactions")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Rule" }));

    const modal = screen.getByTestId("modal");
    fireEvent.change(within(modal).getByLabelText("Frequency"), {
      target: { value: "daily" },
    });

    const repeatRow = within(modal).getByText("Repeat every").closest(
      "div"
    ) as HTMLElement;
    const intervalInput = within(repeatRow).getByRole("spinbutton");

    // Four years (including a leap day) expressed in days.
    expect(intervalInput).toHaveAttribute("max", "1461");

    fireEvent.change(intervalInput, { target: { value: "1461" } });
    expect(intervalInput).toHaveValue(1461);

    // Values above the maximum are clamped down to the cap.
    fireEvent.change(intervalInput, { target: { value: "5000" } });
    expect(intervalInput).toHaveValue(1461);
  });

  it("offers days 1-30 plus Last in the monthly day picker", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => recurringPayload } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }

      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      if (url.startsWith("/api/b/1/payees")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    await waitFor(() => {
      expect(screen.getByText("Recurring Transactions")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Rule" }));

    const modal = screen.getByTestId("modal");
    // The form defaults to monthly, so the day grid renders without changing frequency.
    const dayGrid = within(modal).getByText("Days of Month").parentElement as HTMLElement;

    for (const day of ["1", "28", "29", "30"]) {
      expect(within(dayGrid).getByRole("button", { name: day })).toBeInTheDocument();
    }

    // Day 31 is omitted: Math.min(31, lastDayOfMonth) always equals the last day,
    // so a "31" button would be an exact duplicate of "Last".
    expect(within(dayGrid).queryByRole("button", { name: "31" })).toBeNull();
    expect(within(dayGrid).getByRole("button", { name: "Last" })).toBeInTheDocument();
  });

  it("shows a business-days-only rule's next occurrence on the shifted date", async () => {
    // 2026-02-14 is a Saturday; the occurrence is observed on Monday the 16th.
    const weekendRule = {
      ...recurringPayload[1],
      id: 4,
      name: "Weekend Rule",
      frequency: "monthly",
      daysOfWeek: null,
      weekOfMonth: null,
      daysOfMonth: "[14]",
      nextDate: "2026-02-14",
      businessDaysOnly: true,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => [weekendRule] } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }

      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    await waitFor(() => {
      expect(screen.getByText("Recurring Transactions")).toBeInTheDocument();
    });

    const card = screen.getByTestId("recurring-rule-card-4");
    expect(card.textContent).toContain("(business days only)");
    expect(card.textContent).toContain("Feb 16, 2026");
    expect(card.textContent).not.toContain("Feb 14, 2026");

    // The calendar pill lands on the Monday too, not the scheduled Saturday.
    expect(
      within(screen.getByTestId("calendar-day-cell-2026-02-16")).getByText(
        "Weekend Rule"
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("calendar-day-cell-2026-02-14")).queryByText(
        "Weekend Rule"
      )
    ).not.toBeInTheDocument();
  });

  it("sends businessDaysOnly when the option is ticked on a new rule", async () => {
    let postedBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring" && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({}) } as Response;
      }

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => [] } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }

      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      if (url.startsWith("/api/b/1/payees")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    await waitFor(() => {
      expect(screen.getByText("Recurring Transactions")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Rule" }));

    const modal = screen.getByTestId("modal");
    // businessDaysOnly now lives behind the Advanced disclosure, closed by
    // default so the rarely-used settings stay out of a routine edit.
    fireEvent.click(within(modal).getByRole("button", { name: /advanced/i }));
    const checkbox = within(modal).getByLabelText("Business days only");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    fireEvent.change(within(modal).getByLabelText("Rule Name"), {
      target: { value: "Weekend Rule" },
    });
    fireEvent.submit(modal.querySelector("form")!);

    await waitFor(() => {
      expect(postedBody).not.toBeNull();
    });
    expect(postedBody!.businessDaysOnly).toBe(true);
  });

  it("opens the rule's detail page from the row, not the edit form", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => recurringPayload } as Response;
      }
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }
      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    const card = await screen.findByTestId("recurring-rule-card-1");
    expect(within(card).getByRole("link")).toHaveAttribute(
      "href",
      "/b/1/recurring/1"
    );

    // Edit, Delete and Process Now live on the detail page now. Only
    // Pause/Resume stays on the row.
    expect(within(card).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: "Process Now" })
    ).not.toBeInTheDocument();
  });

  it("pauses a rule inline, without leaving the list", async () => {
    let isActive = true;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring" && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () =>
            recurringPayload.map((rule) =>
              rule.id === 1 ? { ...rule, isActive } : rule
            ),
        } as Response;
      }
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }
      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === "/api/b/1/recurring/1" && init?.method === "PUT") {
        isActive = (JSON.parse(init.body as string) as { isActive: boolean }).isActive;
        return { ok: true, json: async () => ({}) } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringPage />);

    const card = await screen.findByTestId("recurring-rule-card-1");
    fireEvent.click(within(card).getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("recurring-rule-card-1")).getByRole("button", {
          name: "Resume",
        })
      ).toBeInTheDocument();
    });
  });
});

describe("RecurringPage search filter", () => {
  const payeeRule = {
    ...recurringPayload[1],
    id: 4,
    name: "Quarterly Water Bill",
    payeeId: 7,
    payee: { id: 7, name: "Acme Utilities" },
    templateDescription: "Water service",
  };

  const searchPayload = [...recurringPayload, payeeRule];

  const stubFetch = () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/recurring") {
        return { ok: true, json: async () => searchPayload } as Response;
      }
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }
      if (url.startsWith("/api/b/1/recurring/transactions")) {
        return { ok: true, json: async () => [] } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  };

  const search = () => screen.getByLabelText("Search recurring rules");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-08T12:00:00.000Z"));
    stubFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps only the rules whose name matches, ignoring case", async () => {
    render(<RecurringPage />);
    await screen.findByTestId("recurring-rule-card-1");

    fireEvent.change(search(), { target: { value: "friday" } });

    expect(screen.getByTestId("recurring-rule-card-2")).toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-4")).not.toBeInTheDocument();
  });

  it("matches a rule by its payee name", async () => {
    render(<RecurringPage />);
    await screen.findByTestId("recurring-rule-card-4");

    // "Acme Utilities" appears nowhere in rule 4's own name, so a match here
    // can only come from the payee field.
    fireEvent.change(search(), { target: { value: "acme" } });

    expect(screen.getByTestId("recurring-rule-card-4")).toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-2")).not.toBeInTheDocument();
  });

  it("reports an empty result without claiming the book has no rules", async () => {
    render(<RecurringPage />);
    await screen.findByTestId("recurring-rule-card-1");

    fireEvent.change(search(), { target: { value: "no such rule" } });

    expect(screen.getByText("No recurring rules match your search.")).toBeInTheDocument();
    expect(screen.queryByText(/No recurring rules yet/)).not.toBeInTheDocument();
  });

  it("leaves the calendar and the due count showing every rule", async () => {
    render(<RecurringPage />);
    await screen.findByTestId("recurring-rule-card-1");

    // Rules 2 and 4 are the due ones; filtering them out of the list must not
    // change what "Process All Due" will act on.
    expect(
      screen.getByRole("button", { name: "Process All Due (2)" })
    ).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: "Very Long" } });

    expect(screen.queryByTestId("recurring-rule-card-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recurring-rule-card-4")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Process All Due (2)" })
    ).toBeInTheDocument();

    const fridayCell = screen.getByTestId("calendar-day-cell-2026-02-13");
    expect(within(fridayCell).getByText("Friday Catchup Rule")).toBeInTheDocument();
  });
});
