import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PayeeSpendingChart } from "@/components/payees/PayeeSpendingChart";
import type { ReportSplit } from "@/lib/reports";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

function respond(body: unknown, ok = true) {
  return vi.fn(async (..._args: unknown[]) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response);
}

function split(id: number, date: string, accountType: string, amount: number): ReportSplit {
  return {
    splitId: id, transactionId: id, date, amount, accountId: id, accountName: `Account ${id}`,
    accountType, accountParentId: null, payeeId: 7, payeeName: "Cafe",
  };
}

// September: two expense splits (3,000 + 2,000). October: an expense (1,500) and a refund booked as income (-500).
const body = {
  accounts: [],
  splits: [
    split(1, "2026-09-05", "expense", 3_000),
    split(2, "2026-09-20", "expense", 2_000),
    split(3, "2026-10-01", "expense", 1_500),
    split(4, "2026-10-10", "income", -500),
  ],
};

const originalTz = process.env.TZ;

beforeEach(() => {
  // A TZ west of UTC, late on the last day of a month: the UTC date is then the next month,
  // so a request that sends the UTC date fails in every TZ that the test runs in.
  process.env.TZ = "America/Los_Angeles";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T23:30:00"));
  stubResizeObserver(600);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("PayeeSpendingChart", () => {
  it("asks for the 12 local months of income and expense of the payee", async () => {
    const fetchMock = respond(body);
    vi.stubGlobal("fetch", fetchMock);
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    await screen.findByRole("img");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/b/1/reports/data?payeeId=7&accountTypes=income,expense&startDate=2025-11-01&endDate=2026-10-31",
    );
  });

  it("draws one bar for each account type and month", async () => {
    vi.stubGlobal("fetch", respond(body));
    const { container } = render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    expect(await screen.findByRole("img", {
      name: "Totals by month, November 2025 to October 2026: Income $5.00, Expense $65.00",
    })).toBeInTheDocument();
    // The chart draws no rect for a zero value, so September has no income bar.
    const segments = [...container.querySelectorAll("[data-bar-segment]")].map((rect) => rect.getAttribute("data-bar-segment"));
    expect(segments).toEqual(["2026-09/expense/expense", "2026-10/income/income", "2026-10/expense/expense"]);
    // The 12 months of the range are all there, the empty ones too.
    expect([...container.querySelectorAll("[data-bar-hit]")]).toHaveLength(12);
  });

  it("gives screen readers a hidden table of month, type and amount", async () => {
    vi.stubGlobal("fetch", respond(body));
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    const table = await screen.findByRole("table", { name: "Spending by month" });
    // The div clips the wide table, so it cannot make the page scroll sideways.
    expect(table.parentElement).toHaveClass("sr-only");
    const rows = within(table).getAllByRole("row").map((row) => row.textContent);
    // A header row, then an income row and an expense row for each of the 12 months.
    expect(rows).toHaveLength(25);
    expect(rows.slice(0, 3)).toEqual(["MonthTypeAmount", "November 2025Income$0.00", "November 2025Expense$0.00"]);
    expect(rows.slice(-4)).toEqual([
      "September 2026Income$0.00",
      "September 2026Expense$50.00",
      "October 2026Income$5.00",
      "October 2026Expense$15.00",
    ]);
  });

  it("fetches again when the refreshKey changes", async () => {
    const fetchMock = respond(body);
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PayeeSpendingChart bookId="1" payeeId={7} refreshKey={0} />);
    await screen.findByRole("img");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<PayeeSpendingChart bookId="1" payeeId={7} refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The old bars stay on screen until the new splits come.
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("moves the window to the new month when a refresh comes after a month boundary", async () => {
    const november = [...body.splits, split(5, "2026-11-02", "expense", 700)];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ accounts: [], splits: november }) });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PayeeSpendingChart bookId="1" payeeId={7} refreshKey={0} />);
    await screen.findByRole("img", { name: /November 2025 to October 2026/ });
    vi.setSystemTime(new Date("2026-11-01T00:30:00"));
    rerender(<PayeeSpendingChart bookId="1" payeeId={7} refreshKey={1} />);
    // Income $5.00, expense $65.00 + $7.00: the label counts the November spending.
    const chart = await screen.findByRole("img", {
      name: "Totals by month, December 2025 to November 2026: Income $5.00, Expense $72.00",
    });
    expect(chart).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1][0])).toContain("startDate=2025-12-01&endDate=2026-11-01");
    const rows = within(screen.getByRole("table", { name: "Spending by month" })).getAllByRole("row").map((row) => row.textContent);
    expect(rows.slice(-2)).toEqual(["November 2026Income$0.00", "November 2026Expense$7.00"]);
  });

  it("is 200 px high above the breakpoint, and its placeholder has the same height", async () => {
    vi.stubGlobal("fetch", respond(body));
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    expect(screen.getByTestId("payee-spending-placeholder")).toHaveStyle({ height: "200px" });
    expect(await screen.findByRole("img")).toHaveAttribute("height", "200");
  });

  it("says so when the payee has no income or expense in the range", async () => {
    vi.stubGlobal("fetch", respond({ splits: [], accounts: [] }));
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    expect(await screen.findByText("No income or expense in the last 12 months.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows a message when the request fails", async () => {
    vi.stubGlobal("fetch", respond({ error: "Failed to fetch report data" }, false));
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    expect(await screen.findByText("Could not load spending by month.")).toBeInTheDocument();
  });

  it("sends no request while the chart is hidden, and one when it is shown", async () => {
    localStorage.setItem("counterpoise.payeeSpendingChart.hidden", "true");
    const fetchMock = respond(body);
    vi.stubGlobal("fetch", fetchMock);
    render(<PayeeSpendingChart bookId="1" payeeId={7} />);
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await screen.findByRole("img");
  });
});
