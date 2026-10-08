import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RealizedGainsChart } from "@/components/reports/RealizedGainsChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("RealizedGainsChart", () => {
  it("has the title Gains by month", () => {
    render(
      <RealizedGainsChart
        rows={[{ sellDate: "2026-01-15", term: "short", gainCents: 10_000 }]}
        range={{ startDate: "2026-01-01", endDate: "2026-03-31" }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Gains by month" })).toBeInTheDocument();
  });
});
