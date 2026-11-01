import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PriceHistoryChart } from "@/components/securities/PriceHistoryChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

function respond(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
}

// Newest first, as the prices route gives them.
const twoPrices = { prices: [
  { priceDate: "2026-09-30", priceMicros: 120_000_000 },
  { priceDate: "2026-08-31", priceMicros: 100_000_000 },
] };
const chartName = /^Price, last year: from \$100\.00 on Aug 31, 2026 to \$120\.00 on Sep 30, 2026$/;

beforeEach(() => stubResizeObserver(600));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("PriceHistoryChart", () => {
  // The card owns the button, so the chart must be in the card. A chart next to the card stays on Hide chart.
  it("hides the chart with Hide chart, keeps it hidden after a remount, and shows it with Show chart", async () => {
    const fetchMock = respond(twoPrices);
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<PriceHistoryChart bookId="1" securityId={3} refreshKey={0} />);
    expect(screen.getByRole("heading", { name: "Price history" })).toBeInTheDocument();
    await screen.findByRole("img", { name: chartName });
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Range" })).not.toBeInTheDocument();
    unmount();
    render(<PriceHistoryChart bookId="1" securityId={3} refreshKey={0} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    // A hidden chart sends no request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(await screen.findByRole("img", { name: chartName })).toBeInTheDocument();
  });
});
