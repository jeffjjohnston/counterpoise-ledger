import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RecurringRuleDetailPage from "@/app/b/[bookId]/recurring/[id]/page";
import type { TransactionWithSplits } from "@/types";

const mockPush = vi.fn();
vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1", id: "7" }),
    useRouter: () => ({ push: mockPush, replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  })
);

let bookRoleValue: { canWrite: boolean; isOwner: boolean; role: string } = {
  canWrite: true,
  isOwner: true,
  role: "owner",
};

vi.mock("@/components/BookRoleProvider", () => ({
  useBookRole: () => bookRoleValue,
}));

// Stands in for the register table so a history assertion is about how many
// rows the page holds, not how one renders.
vi.mock("@/components/transactions/TransactionList", () => ({
  TransactionList: ({
    transactions,
    onEdit,
  }: {
    transactions: TransactionWithSplits[];
    onEdit: (transaction: TransactionWithSplits) => void;
  }) => (
    <div>
      <div data-testid="transaction-count">{transactions.length}</div>
      <button
        type="button"
        onClick={() => transactions[0] && onEdit(transactions[0])}
        disabled={!transactions[0]}
      >
        Open transaction editor
      </button>
    </div>
  ),
}));

vi.mock("@/components/transactions/TransactionForm", () => ({
  TransactionForm: ({
    editingTransaction,
  }: {
    editingTransaction?: TransactionWithSplits | null;
  }) => (
    <div data-testid="transaction-form">
      Editing transaction {editingTransaction?.id ?? "none"}
    </div>
  ),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
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

const rulePayload = {
  id: 7,
  bookId: 1,
  name: "Monthly Rent",
  frequency: "monthly",
  interval: 1,
  daysOfWeek: null,
  weekOfMonth: null,
  daysOfMonth: null,
  startDate: "2026-01-01",
  endDate: null,
  nextDate: "2026-09-01",
  autoCreateDaysBefore: 0,
  businessDaysOnly: false,
  templateDescription: "Rent payment to landlord",
  payeeId: 3,
  payee: { id: 3, bookId: 1, name: "Landlord", createdAt: "2026-01-01T00:00:00.000Z" },
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  templateSplits: [
    { id: 11, recurringRuleId: 7, accountId: 2, amount: 150000, account: accountPayload[1] },
    { id: 12, recurringRuleId: 7, accountId: 1, amount: -150000, account: accountPayload[0] },
  ],
};

const buildTransaction = (id: number): TransactionWithSplits =>
  ({
    id,
    bookId: 1,
    date: "2026-08-01",
    description: "Rent payment to landlord",
    checkNumber: null,
    notes: null,
    payeeId: 3,
    isReconciled: false,
    isFloating: false,
    recurringRuleId: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
    payee: { id: 3, bookId: 1, name: "Landlord", createdAt: new Date() },
    splits: [],
    investmentSplits: [],
  }) as unknown as TransactionWithSplits;

/**
 * `rule` overrides let a test change one schedule fact without restating the
 * whole payload; `history` maps an offset to the page returned for it.
 */
function mockFetch({
  rule = {},
  history = { 0: [] as TransactionWithSplits[] },
  totalCount = 0,
}: {
  rule?: Partial<typeof rulePayload>;
  history?: Record<number, TransactionWithSplits[]>;
  totalCount?: number;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/b/1/recurring/7" && (!init?.method || init.method === "GET")) {
      return { ok: true, json: async () => ({ ...rulePayload, ...rule }) } as Response;
    }
    if (url === "/api/b/1/recurring/7" && init?.method === "DELETE") {
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    if (url === "/api/b/1/recurring/7" && init?.method === "PUT") {
      return { ok: true, json: async () => ({ ...rulePayload, ...rule }) } as Response;
    }
    if (url === "/api/b/1/recurring/process" && init?.method === "POST") {
      return { ok: true, json: async () => ({ transactionsCreated: 1 }) } as Response;
    }
    if (url.startsWith("/api/b/1/accounts")) {
      return { ok: true, json: async () => accountPayload } as Response;
    }
    if (url.startsWith("/api/b/1/payees")) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url.startsWith("/api/b/1/transactions?")) {
      const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
      return {
        ok: true,
        json: async () => ({ transactions: history[offset] ?? [], totalCount }),
      } as Response;
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  });
}

async function renderPage(options?: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(options);
  vi.stubGlobal("fetch", fetchMock);
  render(<RecurringRuleDetailPage />);
  await screen.findByRole("heading", { name: "Monthly Rent" });
  return fetchMock;
}

describe("RecurringRuleDetailPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    mockPush.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    bookRoleValue = { canWrite: true, isOwner: true, role: "owner" };
  });

  it("hides Process Now, Edit and Delete from a viewer", async () => {
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };
    await renderPage();

    expect(screen.queryByRole("button", { name: "Process Now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows Process Now, Edit and Delete for an owner", async () => {
    await renderPage();

    expect(screen.getByRole("button", { name: "Process Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("names the rule, its state, its payee and its template description", async () => {
    await renderPage();

    expect(screen.getByRole("heading", { name: "Monthly Rent" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Landlord")).toBeInTheDocument();
    expect(screen.getByText("Rent payment to landlord")).toBeInTheDocument();
  });

  it("says Paused for an inactive rule", async () => {
    await renderPage({ rule: { isActive: false } });

    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("describes the recurrence and the next three scheduled dates", async () => {
    await renderPage();

    const schedule = within(screen.getByTestId("rule-schedule"));
    expect(schedule.getByText("Monthly")).toBeInTheDocument();
    // Seeded from the rule's stored nextDate, not re-derived from startDate:
    // re-deriving would show a cadence the rule is not actually on.
    expect(schedule.getByText("Sep 1, 2026")).toBeInTheDocument();
    expect(schedule.getByText("Oct 1, 2026")).toBeInTheDocument();
    expect(schedule.getByText("Nov 1, 2026")).toBeInTheDocument();
  });

  it("writes out the weekend and lead-time rules in words", async () => {
    await renderPage();

    const schedule = within(screen.getByTestId("rule-schedule"));
    expect(schedule.getByText(/weekends included/i)).toBeInTheDocument();
    expect(schedule.getByText(/on the day it is due/i)).toBeInTheDocument();
  });

  it("states the weekend shift and the lead time when the rule sets them", async () => {
    await renderPage({ rule: { businessDaysOnly: true, autoCreateDaysBefore: 3 } });

    const schedule = within(screen.getByTestId("rule-schedule"));
    expect(schedule.getByText(/moves to the next business day/i)).toBeInTheDocument();
    expect(schedule.getByText(/3 days before/i)).toBeInTheDocument();
  });

  it("shows the template splits, the rule's how-much", async () => {
    await renderPage();

    const template = within(screen.getByTestId("rule-template"));
    expect(template.getByText("Rent")).toBeInTheDocument();
    expect(template.getByText("Checking")).toBeInTheDocument();
    expect(template.getByText("$1,500.00")).toBeInTheDocument();
    // formatCurrency emits a true Unicode minus (U+2212), not an ASCII hyphen.
    expect(template.getByText("\u2212$1,500.00")).toBeInTheDocument();
  });

  it("asks the shared transactions endpoint for this rule's history", async () => {
    const fetchMock = await renderPage({
      history: { 0: [buildTransaction(1)] },
      totalCount: 1,
    });

    await waitFor(() => {
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("1");
    });

    const historyCalls = fetchMock.mock.calls
      .map(([request]) => (typeof request === "string" ? request : request.toString()))
      .filter((url) => url.startsWith("/api/b/1/transactions?"));

    expect(historyCalls).toEqual([
      "/api/b/1/transactions?recurringRuleId=7&limit=12&offset=0&includeMeta=true",
    ]);
  });

  it("appends the next twelve when Load more is clicked", async () => {
    const firstPage = Array.from({ length: 12 }, (_, i) => buildTransaction(i + 1));
    const secondPage = Array.from({ length: 12 }, (_, i) => buildTransaction(i + 13));

    const fetchMock = await renderPage({
      history: { 0: firstPage, 12: secondPage },
      totalCount: 24,
    });

    await waitFor(() => {
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("12");
    });

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => {
      // 24, not 12: the second page is appended to the first, not swapped in.
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("24");
    });

    const historyCalls = fetchMock.mock.calls
      .map(([request]) => (typeof request === "string" ? request : request.toString()))
      .filter((url) => url.startsWith("/api/b/1/transactions?"));

    expect(historyCalls).toEqual([
      "/api/b/1/transactions?recurringRuleId=7&limit=12&offset=0&includeMeta=true",
      "/api/b/1/transactions?recurringRuleId=7&limit=12&offset=12&includeMeta=true",
    ]);
  });

  it("offers no Load more once the whole history is on screen", async () => {
    await renderPage({ history: { 0: [buildTransaction(1)] }, totalCount: 1 });

    await waitFor(() => {
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("1");
    });
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("opens the transaction editor from a history row", async () => {
    await renderPage({ history: { 0: [buildTransaction(101)] }, totalCount: 1 });

    await waitFor(() => {
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open transaction editor" }));

    expect(await screen.findByTestId("transaction-form")).toHaveTextContent(
      "Editing transaction 101"
    );
  });

  it("opens the edit form in a modal", async () => {
    await renderPage();

    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const modal = within(await screen.findByTestId("modal"));
    expect(modal.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();
  });

  it("closes the rule edit form when the role drops to viewer", async () => {
    // The role can change while the form is open: the role loads after the
    // page, and an owner can demote a member at any time. A viewer must not
    // keep an editable form. The server refuses the save.
    vi.stubGlobal("fetch", mockFetch());
    const { rerender } = render(<RecurringRuleDetailPage />);
    await screen.findByRole("heading", { name: "Monthly Rent" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      await screen.findByRole("heading", { name: "Edit Recurring Transaction" })
    ).toBeInTheDocument();

    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };
    rerender(<RecurringRuleDetailPage />);

    expect(
      screen.queryByRole("heading", { name: "Edit Recurring Transaction" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("titles a viewer's transaction modal without Edit", async () => {
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };
    await renderPage({ history: { 0: [buildTransaction(101)] }, totalCount: 1 });

    await waitFor(() => {
      expect(screen.getByTestId("transaction-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open transaction editor" }));

    expect(await screen.findByRole("heading", { name: "Transaction" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Edit Transaction" })).not.toBeInTheDocument();
  });

  it("returns to the list after deleting the rule", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const deleted = fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE"
      );
      expect(deleted).toBe(true);
    });

    // The rule no longer exists, so staying on its detail page would render a
    // page about nothing.
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/b/1/recurring");
    });
  });

  it("processes the rule on demand", async () => {
    const fetchMock = await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Process Now" }));

    await waitFor(() => {
      const processed = fetchMock.mock.calls.find(
        ([request]) =>
          (typeof request === "string" ? request : request.toString()) ===
          "/api/b/1/recurring/process"
      );
      expect(processed).toBeDefined();
      expect(JSON.parse((processed![1] as RequestInit).body as string)).toEqual({
        ruleId: 7,
      });
    });
  });

  it("says so when the rule does not exist", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/recurring/7") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Recurring rule not found" }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions?")) {
        return { ok: true, json: async () => ({ transactions: [], totalCount: 0 }) } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RecurringRuleDetailPage />);

    expect(await screen.findByText("Recurring rule not found.")).toBeInTheDocument();
  });
});
