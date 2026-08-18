import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReportTable } from "@/components/reports/ReportTable";

describe("ReportTable", () => {
  it("renders an empty state when there are no groups", () => {
    render(<ReportTable groups={[]} grandTotal={0} dimensions={["month"]} />);

    expect(
      screen.getByText(/No data found for the selected filters/i)
    ).toBeInTheDocument();
  });

  it("expands and collapses report groups", () => {
    render(
      <ReportTable
        groups={[
          {
            key: "2025-01",
            label: "January 2025",
            total: 12500,
            depth: 0,
            children: [],
            splits: [
              {
                splitId: 1,
                transactionId: 10,
                date: "2025-01-15",
                amount: 12500,
                accountId: 1,
                accountName: "Groceries",
                accountType: "expense",
                accountParentId: null,
                payeeId: 1,
                payeeName: "Market",
              },
            ],
          },
        ]}
        grandTotal={12500}
        dimensions={["month"]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(screen.getByText("Market")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(screen.queryByText("Market")).not.toBeInTheDocument();
  });
});
