import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ReportConfigPanel,
  type ReportConfig,
} from "@/components/reports/ReportConfigPanel";

vi.mock("@/components/ui/AccountAutocomplete", () => ({
  AccountAutocomplete: ({
    onChange,
  }: {
    onChange: (accountId: number | null) => void;
  }) => (
    <button type="button" onClick={() => onChange(2)}>
      Add Account Filter
    </button>
  ),
}));

const baseConfig: ReportConfig = {
  startDate: "2026-01-01",
  endDate: "2026-03-11",
  accountTypes: ["income", "expense"],
  accountIds: [],
  groupings: ["month"],
  collapseToParent: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReportConfigPanel", () => {
  it("applies a date preset through onChange", () => {
    const handleChange = vi.fn();
    render(
      <ReportConfigPanel
        config={baseConfig}
        onChange={handleChange}
        onGenerate={vi.fn()}
        accounts={[]}
        loading={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Last Year" }));

    expect(handleChange).toHaveBeenCalledWith({
      ...baseConfig,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  });

  it("adds an account filter via the autocomplete callback", () => {
    const handleChange = vi.fn();
    render(
      <ReportConfigPanel
        config={baseConfig}
        onChange={handleChange}
        onGenerate={vi.fn()}
        accounts={[
          {
            id: 2,
            bookId: 1,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            name: "Checking",
            type: "asset",
            subtype: "bank",
            parentId: null,
            isActive: true,
            isFavorite: false,
            isInvestmentCash: false,
            icon: null,
            balance: 0,
            hasTransactions: false,
          },
        ]}
        loading={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Account Filter" }));

    expect(handleChange).toHaveBeenCalledWith({
      ...baseConfig,
      accountIds: [2],
    });
  });

  it("invokes onGenerate from the primary action", () => {
    const handleGenerate = vi.fn();
    render(
      <ReportConfigPanel
        config={baseConfig}
        onChange={vi.fn()}
        onGenerate={handleGenerate}
        accounts={[]}
        loading={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate Report" }));

    expect(handleGenerate).toHaveBeenCalled();
  });
});
