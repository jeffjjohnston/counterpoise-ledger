import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AreaChart } from "@/components/charts/AreaChart";
import type { LineSeries } from "@/components/charts/types";

import { stubResizeObserver } from "@/tests/helpers/resize-observer";

const dates = ["2026-01-31", "2026-02-28", "2026-03-31"];

function series(key: string, label: string, color: string, values: number[]): LineSeries {
  return { key, label, color, points: values.map((value, index) => ({ date: dates[index], value })) };
}

const bank = series("bank", "Bank", "var(--chart-1)", [100_000, 200_000, 300_000]);
const brokerage = series("brokerage", "Brokerage", "var(--chart-2)", [50_000, 50_000, 80_000]);
const card = series("card", "Card", "var(--chart-3)", [-20_000, -60_000, -30_000]);
const total = series("netWorth", "Net worth", "var(--fg-primary)", [130_000, 190_000, 350_000]);

/** The y coordinates of the points of a path from d3-shape ("M0,10L5,20Z"). */
function pathYs(path: Element): number[] {
  return [...(path.getAttribute("d") ?? "").matchAll(/[ML]-?[\d.]+,(-?[\d.]+)/g)].map((match) => Number(match[1]));
}

beforeEach(() => stubResizeObserver(600));
afterEach(() => vi.unstubAllGlobals());

describe("AreaChart", () => {
  it("draws one area for each series and the total line", () => {
    const { container } = render(
      <AreaChart series={[bank, brokerage, card]} total={total} height={200} ariaLabel="Net worth by group" />,
    );
    expect(screen.getByRole("img", { name: "Net worth by group" })).toBeInTheDocument();
    for (const key of ["bank", "brokerage", "card"]) {
      const area = container.querySelector(`[data-area-series='${key}']`)!;
      expect(area.getAttribute("d")).toMatch(/^M/);
    }
    expect(container.querySelectorAll("[data-area-series]")).toHaveLength(3);
    const line = container.querySelector("[data-area-total]")!;
    expect(line.getAttribute("stroke")).toBe("var(--fg-primary)");
    expect(line.getAttribute("stroke-width")).toBe("2");
  });

  it("stacks a positive series above the zero line and a negative series below it", () => {
    const { container } = render(
      <AreaChart series={[bank, brokerage, card]} height={200} ariaLabel="Net worth by group" />,
    );
    const zero = Number(container.querySelector("[data-zero-line]")!.getAttribute("y1"));
    // SVG y grows downward: above the line is a smaller y.
    const cardYs = pathYs(container.querySelector("[data-area-series='card']")!);
    expect(cardYs.length).toBeGreaterThan(0);
    expect(Math.min(...cardYs)).toBeCloseTo(zero);
    expect(Math.max(...cardYs)).toBeGreaterThan(zero);
    const bankYs = pathYs(container.querySelector("[data-area-series='bank']")!);
    expect(Math.max(...bankYs)).toBeCloseTo(zero);
    expect(Math.min(...bankYs)).toBeLessThan(zero);
    // Brokerage stacks on Bank, so its lowest edge is the top of Bank.
    const brokerageYs = pathYs(container.querySelector("[data-area-series='brokerage']")!);
    expect(Math.max(...brokerageYs)).toBeLessThan(zero);
  });

  it("shows the date, each series and the total on hover", () => {
    const { container } = render(
      <AreaChart series={[bank, brokerage, card]} total={total} height={200} ariaLabel="Net worth by group" />,
    );
    // The plot is 600 - 56 - 12 = 532 px wide; the middle point is near x = 56 + 266.
    fireEvent.mouseMove(container.querySelector("[data-area-overlay]")!, { clientX: 322, clientY: 50 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Feb 28, 2026");
    expect(tooltip).toHaveTextContent("Bank$2,000.00");
    expect(tooltip).toHaveTextContent("Brokerage$500.00");
    expect(tooltip).toHaveTextContent("Card−$600.00");
    expect(tooltip).toHaveTextContent("Total$1,900.00");
    fireEvent.mouseLeave(container.querySelector("svg")!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("names the total row with totalLabel", () => {
    const { container } = render(
      <AreaChart series={[bank, brokerage, card]} total={total} totalLabel="Net worth" height={200} ariaLabel="Net worth by group" />,
    );
    fireEvent.mouseMove(container.querySelector("[data-area-overlay]")!, { clientX: 322, clientY: 50 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Net worth$1,900.00");
    expect(tooltip).not.toHaveTextContent("Total");
  });

  it("opens the tooltip on a tap, adds the series without a total, and closes on a tap outside", () => {
    const { container } = render(
      <AreaChart series={[bank, card]} height={200} ariaLabel="Net worth by group" />,
    );
    fireEvent.click(container.querySelector("[data-area-overlay]")!, { clientX: 70, clientY: 50 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Jan 31, 2026");
    expect(tooltip).toHaveTextContent("Total$800.00");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
