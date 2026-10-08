import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { tickLabelWidth } from "@/components/charts/Axis";
import { BarChart, labelWidth, stackSegments, truncateLabel } from "@/components/charts/BarChart";
import type { BarGroup, ChartSeries } from "@/components/charts/types";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

const series: ChartSeries[] = [
  { key: "food", label: "Food", color: "var(--chart-1)" },
  { key: "rent", label: "Rent", color: "var(--chart-2)" },
];

const groups: BarGroup[] = [
  { key: "2026-01", label: "Jan 2026", bars: [{ key: "expense", label: "Expense", segments: [
    { seriesKey: "food", value: 30_000 }, { seriesKey: "rent", value: 150_000 },
  ] }] },
  { key: "2026-02", label: "Feb 2026", bars: [{ key: "expense", label: "Expense", segments: [
    { seriesKey: "food", value: -5_000 }, { seriesKey: "rent", value: 0 },
  ] }] },
];

beforeEach(() => stubResizeObserver(600));
afterEach(() => vi.unstubAllGlobals());

describe("stackSegments", () => {
  it("stacks positive values up and negative values down from zero", () => {
    expect(stackSegments([10, -4, 5, -1])).toEqual([[0, 10], [-4, 0], [10, 15], [-5, -4]]);
  });
});

describe("truncateLabel", () => {
  it("cuts a long label and keeps a short one", () => {
    expect(truncateLabel("Short")).toBe("Short");
    expect(truncateLabel("A very long payee name for a store")).toBe("A very long payee…");
  });
});

describe("BarChart", () => {
  it("draws one rectangle for each segment that is not zero", () => {
    const { container } = render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    expect(screen.getByRole("img", { name: "Spending" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-bar-segment]")).toHaveLength(3);
  });

  it("draws a negative segment below the zero line", () => {
    const { container } = render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    const zero = Number(container.querySelector("[data-zero-line]")!.getAttribute("y1"));
    const negative = container.querySelector('[data-bar-segment="2026-02/expense/food"]')!;
    expect(Number(negative.getAttribute("y"))).toBeGreaterThanOrEqual(zero);
  });

  it("shows the label, each value and the total on hover", () => {
    const { container } = render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    fireEvent.mouseMove(container.querySelector('[data-bar-hit="2026-01"]')!, { clientX: 100, clientY: 50 });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Jan 2026");
    expect(tooltip).toHaveTextContent("Food$300.00");
    expect(tooltip).toHaveTextContent("Rent$1,500.00");
    expect(tooltip).toHaveTextContent("Total$1,800.00");
  });

  it("shows the detail of a segment next to its value", () => {
    const shares: BarGroup[] = [
      { key: "security:1", label: "VTI", bars: [{ key: "value", label: "VTI", segments: [
        { seriesKey: "food", value: 75_000, detail: "75.0%" },
      ] }] },
      { key: "security:2", label: "BND", bars: [{ key: "value", label: "BND", segments: [
        { seriesKey: "food", value: 25_000, detail: "25.0%" },
      ] }] },
    ];
    const { container } = render(
      <BarChart groups={shares} series={series} orientation="horizontal" height={120} ariaLabel="Allocation" />,
    );
    fireEvent.mouseMove(container.querySelector('[data-bar-hit="security:1"]')!, { clientX: 200, clientY: 20 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Food75.0%$750.00");
  });

  it("shows the tooltip on a tap and hides it when the pointer leaves", () => {
    const { container } = render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    fireEvent.click(container.querySelector('[data-bar-hit="2026-02"]')!, { clientX: 300, clientY: 50 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Feb 2026");
    fireEvent.mouseLeave(container.querySelector("svg")!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("cuts a long category label and shows the full name in the tooltip", () => {
    const long = "A very long payee name for a store";
    const ranked: BarGroup[] = [{ key: "payee:1", label: long, bars: [{ key: "total", label: long, segments: [{ seriesKey: "total", value: 900 }] }] }];
    const { container } = render(
      <BarChart groups={ranked} series={[{ key: "total", label: "Total", color: "var(--chart-1)" }]}
        orientation="horizontal" height={60} ariaLabel="Payees" />,
    );
    expect(screen.getByText("A very long payee…")).toBeInTheDocument();
    fireEvent.mouseMove(container.querySelector('[data-bar-hit="payee:1"]')!, { clientX: 200, clientY: 20 });
    expect(screen.getByRole("tooltip")).toHaveTextContent(long);
  });

  it("draws nothing until the container has a width", () => {
    stubResizeObserver(0);
    render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("closes the tooltip on a pointer down outside the chart, and on Escape", () => {
    const { container } = render(<BarChart groups={groups} series={series} height={240} ariaLabel="Spending" />);
    const hit = container.querySelector('[data-bar-hit="2026-01"]')!;
    fireEvent.click(hit, { clientX: 100, clientY: 50 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(hit, { clientX: 100, clientY: 50 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows fewer category labels on a narrow chart and keeps them apart", () => {
    const weeks: BarGroup[] = Array.from({ length: 12 }, (_, index) => ({
      key: `w${index}`,
      label: `Week of Jan ${index + 1}, 2026`,
      bars: [{ key: "expense", label: "Expense", segments: [{ seriesKey: "food", value: 1_000 }] }],
    }));
    const shown = (width: number) => {
      stubResizeObserver(width);
      const { container, unmount } = render(<BarChart groups={weeks} series={series} height={240} ariaLabel="Weeks" />);
      const texts = Array.from(container.querySelectorAll("g[fill='var(--fg-tertiary)'] text"));
      const xs = texts.map((node) => Number(node.getAttribute("x")));
      unmount();
      return xs;
    };
    const narrow = shown(390);
    const wide = shown(1200);
    expect(narrow.length).toBeLessThan(wide.length);
    const estimated = labelWidth(weeks);
    for (const xs of [narrow, wide]) {
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(estimated);
    }
  });

  /** The value labels and the grid lines of the bottom axis of a horizontal chart from −$1.5M to $1.2M. */
  function bottomAxis(width: number) {
    const ranked: BarGroup[] = [
      { key: "a", label: "A", bars: [{ key: "total", label: "A", segments: [{ seriesKey: "total", value: -150_000_000 }] }] },
      { key: "b", label: "B", bars: [{ key: "total", label: "B", segments: [{ seriesKey: "total", value: 120_000_000 }] }] },
    ];
    stubResizeObserver(width);
    const { container, unmount } = render(
      <BarChart groups={ranked} series={[{ key: "total", label: "Total", color: "var(--chart-1)" }]}
        orientation="horizontal" height={120} ariaLabel="Accounts" />,
    );
    const axis = container.querySelector("g[font-size='10']")!;
    const gridLines = axis.querySelectorAll("line").length;
    const texts = Array.from(axis.querySelectorAll("text"));
    const labels = texts.map((node) => node.textContent ?? "");
    const xs = texts.map((node) => Number(node.getAttribute("x")));
    unmount();
    return { gridLines, labels, xs };
  }

  it("shows fewer value labels on the bottom axis of a narrow horizontal chart, keeps them apart and keeps $0", () => {
    // The plot is 260 - 128 - 16 = 116 px wide.
    const { gridLines, labels, xs } = bottomAxis(260);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.length).toBeLessThan(gridLines);
    expect(labels).toContain("$0");
    const estimated = tickLabelWidth(labels.map((label) => ({ value: 0, position: 0, label })));
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(estimated);
  });

  it("counts the shown value labels from $0, so that $0 shows on a plot 200 px wide", () => {
    // The plot is 344 - 128 - 16 = 200 px wide. A count from the first tick shows only −$1.5M, −$500k and $500k.
    const { labels } = bottomAxis(344);
    expect(labels).toEqual(["−$1M", "$0", "$1M"]);
  });
});
