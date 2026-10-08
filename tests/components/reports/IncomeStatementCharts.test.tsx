import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IncomeStatementCharts } from "@/components/reports/IncomeStatementCharts";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";
import type { ReportAccount } from "@/lib/reports";

function split(date: string, amount: number, accountType: string) {
  return {
    splitId: 1, transactionId: 1, date, amount, accountId: 1, accountName: "A",
    accountType, accountParentId: null, payeeId: null, payeeName: null,
  };
}

const twoMonths = { splits: [
  split("2026-01-05", -300_000, "income"),
  split("2026-01-10", 100_000, "expense"),
  split("2026-02-03", 40_000, "expense"),
] };

function respond(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
}

const accounts: ReportAccount[] = [
  { id: 1, name: "Housing", type: "expense", parentId: null },
  { id: 2, name: "Rent", type: "expense", parentId: 1 },
];
const active = new Set([1, 2]);
const rows = [{ accountId: 2, balance: 90_000 }];

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("IncomeStatementCharts", () => {
  it("requests income and expense splits for the period and draws both charts", async () => {
    const fetchMock = respond(twoMonths);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IncomeStatementCharts bookId="1" monthlyRange={{ startDate: "2026-01-01", endDate: "2026-02-28" }}
        expenseRows={rows} accounts={accounts} activeAccountIds={active} />,
    );
    expect(await screen.findByRole("img", { name: /Income and expense by month, January 2026 to February 2026/ }))
      .toBeInTheDocument();
    expect(String((fetchMock.mock.calls as unknown[][])[0][0])).toBe(
      "/api/b/1/reports/data?accountTypes=income%2Cexpense&startDate=2026-01-01&endDate=2026-02-28",
    );
    expect(screen.getByRole("img", { name: /Expense by category, 2026-01-01 to 2026-02-28, largest Housing at \$900\.00/ })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$3,000.00" })).toBeInTheDocument();
  });

  it("leaves out the splits of inactive accounts, as the page totals do", async () => {
    const inactive = { ...split("2026-01-12", 50_00, "expense"), accountId: 9 };
    vi.stubGlobal("fetch", respond({ splits: [
      { ...split("2026-01-10", 10_00, "expense"), accountId: 2 },
      inactive,
      { ...split("2026-02-03", 20_00, "expense"), accountId: 2 },
    ] }));
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={[]} accounts={accounts}
      activeAccountIds={active} />);
    const table = await screen.findByRole("table", { name: "Income and expense by month" });
    const rowsText = within(table).getAllByRole("row").map((row) => row.textContent);
    expect(rowsText).toEqual([
      "MonthIncomeExpenseNet",
      "January 2026$0.00$10.00−$10.00",
      "February 2026$0.00$20.00−$20.00",
    ]);
  });

  it("clips the hidden table in a div, so that it cannot widen the page", async () => {
    vi.stubGlobal("fetch", respond(twoMonths));
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={[]} accounts={accounts} activeAccountIds={active} />);
    const table = await screen.findByRole("table", { name: "Income and expense by month" });
    expect(table.parentElement).toHaveClass("sr-only");
  });

  it("holds the height of the chart while it loads", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={[]} accounts={accounts} activeAccountIds={active} />);
    expect(screen.getByTestId("income-monthly-placeholder")).toHaveStyle({ height: "200px" });
  });

  it("sends no dates for all time", async () => {
    const fetchMock = respond(twoMonths);
    vi.stubGlobal("fetch", fetchMock);
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={[]} accounts={accounts} activeAccountIds={active} />);
    await screen.findByRole("img", { name: /Income and expense by month/ });
    expect(String((fetchMock.mock.calls as unknown[][])[0][0])).toBe("/api/b/1/reports/data?accountTypes=income%2Cexpense");
    expect(screen.queryByText("Expense by category")).not.toBeInTheDocument();
  });

  it("sends no request while the monthly chart is hidden", () => {
    localStorage.setItem("counterpoise.incomeByMonthChart.hidden", "true");
    const fetchMock = respond(twoMonths);
    vi.stubGlobal("fetch", fetchMock);
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={rows} accounts={accounts} activeAccountIds={active} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
  });

  it("hides the category chart on its own key", () => {
    vi.stubGlobal("fetch", respond(twoMonths));
    render(<IncomeStatementCharts bookId="1" monthlyRange={null} expenseRows={rows} accounts={accounts} activeAccountIds={active} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(localStorage.getItem("counterpoise.expenseBreakdownChart.hidden")).toBe("true");
  });

  it("gives one row per year in the table when the range has more than 24 months", async () => {
    vi.stubGlobal("fetch", respond({ splits: [
      split("2023-01-05", 10_000, "expense"),
      split("2025-03-05", 20_000, "expense"),
    ] }));
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={rows} accounts={accounts} activeAccountIds={active} />);
    expect(screen.getByRole("heading", { name: "Income and expense" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Income and expense by year" });
    expect(within(table).getByRole("columnheader", { name: "Year" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent))
      .toEqual(["2023", "2024", "2025"]);
  });

  it("removes the monthly card for fewer than 2 months", async () => {
    vi.stubGlobal("fetch", respond({ splits: [split("2026-01-05", 100, "expense")] }));
    render(<IncomeStatementCharts bookId="1" monthlyRange={{}} expenseRows={rows} accounts={accounts} activeAccountIds={active} />);
    await waitFor(() => expect(screen.queryByText("Income and expense")).not.toBeInTheDocument());
    expect(screen.getByText("Expense by category")).toBeInTheDocument();
  });

  it("renders nothing with a null range and no expense", () => {
    const { container } = render(
      <IncomeStatementCharts bookId="1" monthlyRange={null} expenseRows={[]} accounts={accounts} activeAccountIds={active} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
