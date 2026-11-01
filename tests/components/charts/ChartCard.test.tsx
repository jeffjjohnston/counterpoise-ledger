import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChartCard } from "@/components/charts/ChartCard";

const KEY = "counterpoise.testChart.hidden";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChartCard", () => {
  it("shows the title prop, and \"Chart\" when it has none", () => {
    const { unmount } = render(<ChartCard storageKey={KEY} title="Net worth"><p>body</p></ChartCard>);
    expect(screen.getByRole("heading", { name: "Net worth" })).toBeInTheDocument();
    unmount();
    render(<ChartCard storageKey={KEY}><p>body</p></ChartCard>);
    expect(screen.getByRole("heading", { name: "Chart" })).toBeInTheDocument();
  });

  it("shows the actions only while the chart is shown", () => {
    render(<ChartCard storageKey={KEY} actions={<button type="button">Range</button>}><p>body</p></ChartCard>);
    expect(screen.getByRole("button", { name: "Range" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("button", { name: "Range" })).not.toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("button", { name: "Range" })).toBeInTheDocument();
  });

  it("lets the actions wrap, and keeps each label whole", () => {
    render(<ChartCard storageKey={KEY} actions={<button type="button">Range</button>}><p>body</p></ChartCard>);
    const actions = screen.getByRole("button", { name: "Range" }).parentElement!;
    expect(actions).toHaveClass("flex-wrap");
    expect(actions).not.toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("button", { name: "Hide chart" })).toHaveClass("whitespace-nowrap");
  });

  it("takes less height while the chart is hidden", () => {
    render(<ChartCard storageKey={KEY} title="Balance"><p>body</p></ChartCard>);
    const card = screen.getByRole("heading", { name: "Balance" }).closest("section")!;
    const header = screen.getByRole("heading", { name: "Balance" }).parentElement!;
    expect(card).toHaveClass("py-4");
    expect(header).toHaveClass("mb-2");
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(card).toHaveClass("py-2");
    expect(card).not.toHaveClass("py-4");
    expect(header).not.toHaveClass("mb-2");
  });

  it("keeps the hidden state after a remount, and the shown state too", () => {
    const { unmount } = render(<ChartCard storageKey={KEY}><p>body</p></ChartCard>);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    unmount();
    const second = render(<ChartCard storageKey={KEY}><p>body</p></ChartCard>);
    expect(screen.queryByText("body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByText("body")).toBeInTheDocument();
    second.unmount();
    render(<ChartCard storageKey={KEY}><p>body</p></ChartCard>);
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide chart" })).toBeInTheDocument();
  });

  it("works when the storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ChartCard storageKey={KEY}><p>body</p></ChartCard>);
    expect(screen.getByText("body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });
});
