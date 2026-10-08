import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LineChart } from "@/components/charts/LineChart";
import type { LineSeries } from "@/components/charts/types";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

const netWorth: LineSeries = {
  key: "netWorth", label: "Net worth", color: "var(--chart-1)",
  points: [
    { date: "2026-01-31", value: 100_000 },
    { date: "2026-02-28", value: -50_000 },
    { date: "2026-03-31", value: 250_000 },
  ],
};

beforeEach(() => stubResizeObserver(600));
afterEach(() => vi.unstubAllGlobals());

describe("LineChart", () => {
  it("draws one path for each series", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    expect(screen.getByRole("img", { name: "Net worth" })).toBeInTheDocument();
    const path = container.querySelector("[data-line-series='netWorth']")!;
    expect(path.getAttribute("d")).toMatch(/^M/);
  });

  it("shows the nearest point on hover, with the minus sign for a negative value", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    // The plot is 600 - 56 - 12 = 532 px wide; the middle point is near x = 56 + 266.
    fireEvent.mouseMove(container.querySelector("[data-line-overlay]")!, { clientX: 322, clientY: 50 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Feb 28, 2026");
    expect(tooltip).toHaveTextContent("Net worth−$500.00");
  });

  it("puts the zero tick between the lowest and highest point when values go below zero", () => {
    render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    expect(screen.getByText("$0")).toBeInTheDocument();
  });

  it("makes the left margin wider when a value label is longer than the margin", () => {
    const narrow: LineSeries = {
      key: "netWorth", label: "Net worth", color: "var(--chart-1)",
      points: [{ date: "2026-01-31", value: -100_000_000 }, { date: "2026-02-28", value: -100_020_000 }],
    };
    const { container } = render(<LineChart series={[narrow]} height={200} ariaLabel="Net worth" />);
    expect(screen.getByText("−$1.00005M")).toBeInTheDocument();
    // "−$1.00005M" has 10 characters: 10 * 6 + 8 = 68 px, more than the 56 px default.
    expect(container.querySelector("svg > g")!.getAttribute("transform")).toBe("translate(68,8)");
  });

  it("keeps the default left margin for short value labels", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    expect(container.querySelector("svg > g")!.getAttribute("transform")).toBe("translate(56,8)");
  });

  it("hides the tooltip when the pointer leaves", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    fireEvent.click(container.querySelector("[data-line-overlay]")!, { clientX: 70, clientY: 50 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jan 31, 2026");
    fireEvent.mouseLeave(container.querySelector("svg")!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("anchors the last date label at its end so the margin does not clip it", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    const labels = Array.from(container.querySelectorAll("g[fill='var(--fg-tertiary)'] text"));
    expect(labels.length).toBeGreaterThan(1);
    expect(labels[labels.length - 1].getAttribute("text-anchor")).toBe("end");
    expect(labels[0].getAttribute("text-anchor")).toBe("start");
  });

  it("closes the tooltip on a pointer down outside the chart, and on Escape", () => {
    const { container } = render(<LineChart series={[netWorth]} height={200} ariaLabel="Net worth" />);
    const overlay = container.querySelector("[data-line-overlay]")!;
    fireEvent.click(overlay, { clientX: 70, clientY: 50 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(overlay, { clientX: 70, clientY: 50 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
