import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RealizedGainsChart } from "@/components/reports/RealizedGainsChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const rows = [{ sellDate: "2026-01-15", term: "short" as const, gainCents: 10_000 }];
const range = { startDate: "2026-01-01", endDate: "2026-03-31" };
const chartName = /^Realized gains .*: short term \$100\.00, long term \$0\.00$/;

describe("RealizedGainsChart", () => {
  it("has the title Gains by month", () => {
    render(<RealizedGainsChart rows={rows} range={range} />);
    expect(screen.getByRole("heading", { name: "Gains by month" })).toBeInTheDocument();
  });

  // The card owns the button, so the chart must be in the card. A chart next to the card stays on Hide chart.
  it("hides the chart with Hide chart, keeps it hidden after a remount, and shows it with Show chart", () => {
    const { unmount } = render(<RealizedGainsChart rows={rows} range={range} />);
    expect(screen.getByRole("img", { name: chartName })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    unmount();
    render(<RealizedGainsChart rows={rows} range={range} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("img", { name: chartName })).toBeInTheDocument();
  });
});
