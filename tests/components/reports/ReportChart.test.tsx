import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReportChart } from "@/components/reports/ReportChart";
import { groupSplits, type ReportAccount, type ReportSplit } from "@/lib/reports";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

const accounts = new Map<number, ReportAccount>([
  [10, { id: 10, name: "Salary", type: "income", parentId: null }],
  [20, { id: 20, name: "Groceries", type: "expense", parentId: null }],
]);

function split(id: number, date: string, accountId: number, amount: number): ReportSplit {
  const account = accounts.get(accountId)!;
  return {
    splitId: id, transactionId: id, date, amount, accountId, accountName: account.name,
    accountType: account.type, accountParentId: null, payeeId: null, payeeName: null,
  };
}

const groups = groupSplits(
  [split(1, "2026-01-05", 10, -500_000), split(2, "2026-01-09", 20, 20_000), split(3, "2026-02-03", 20, 30_000)],
  ["month"], accounts, false,
);

beforeEach(() => {
  stubResizeObserver(600);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReportChart", () => {
  it("has the title Report", () => {
    render(<ReportChart groups={groups} dimensions={["month"]} />);
    expect(screen.getByRole("heading", { name: "Report" })).toBeInTheDocument();
  });

  it("draws the chart and a legend for the account types", () => {
    render(<ReportChart groups={groups} dimensions={["month"]} />);
    expect(
      screen.getByRole("img", { name: "Totals by month, January 2026 to February 2026: Income $5,000.00, Expense $500.00" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expense")).toBeInTheDocument();
  });

  it("draws nothing without a grouping", () => {
    const { container } = render(<ReportChart groups={[]} dimensions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the chart and keeps the choice", () => {
    const { unmount } = render(<ReportChart groups={groups} dimensions={["month"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    unmount();
    render(<ReportChart groups={groups} dimensions={["month"]} />);
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
  });

  it("works when storage is not available", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<ReportChart groups={groups} dimensions={["month"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
  });
});
