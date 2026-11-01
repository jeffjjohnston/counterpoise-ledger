import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AllocationChart } from "@/components/securities/AllocationChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const securities = [
  { id: 1, symbol: "VTI", name: "VTI fund", marketValueCents: 75_000 },
  { id: 2, symbol: "BND", name: "BND fund", marketValueCents: 25_000 },
];
const chartName = /^Market value by security, largest VTI at \$750\.00/;

describe("AllocationChart", () => {
  it("has the title Allocation", () => {
    render(<AllocationChart securities={securities} />);
    expect(screen.getByRole("heading", { name: "Allocation" })).toBeInTheDocument();
  });

  // The card owns the button, so the chart must be in the card. A chart next to the card stays on Hide chart.
  it("hides the chart with Hide chart, keeps it hidden after a remount, and shows it with Show chart", () => {
    const { unmount } = render(<AllocationChart securities={securities} />);
    expect(screen.getByRole("img", { name: chartName })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    unmount();
    render(<AllocationChart securities={securities} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("img", { name: chartName })).toBeInTheDocument();
  });
});
