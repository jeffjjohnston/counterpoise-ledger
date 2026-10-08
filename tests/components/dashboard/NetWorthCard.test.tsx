import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NetWorthCard } from "@/components/dashboard/NetWorthCard";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

function respond(body: unknown, ok = true) {
  return vi.fn(async (..._args: unknown[]) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response);
}

const twoPoints = { points: [
  { date: "2026-08-31", netWorthCents: 100_000 },
  { date: "2026-09-30", netWorthCents: 150_000 },
] };

const grouped = {
  groups: [{ accountId: 1, name: "Bank" }, { accountId: 2, name: "Card" }],
  points: [
    { date: "2026-08-31", netWorthCents: 100_000, groups: [
      { accountId: 1, valueCents: 120_000 }, { accountId: 2, valueCents: -20_000 }] },
    { date: "2026-09-30", netWorthCents: 150_000, groups: [
      { accountId: 1, valueCents: 180_000 }, { accountId: 2, valueCents: -30_000 }] },
  ],
};

/** The grouped body for a request with groupBy, else the plain points. */
function respondByView() {
  return vi.fn(async (input: unknown) => ({
    ok: true,
    status: 200,
    json: async () => (String(input).includes("groupBy=account") ? grouped : twoPoints),
  }) as Response);
}

const originalTz = process.env.TZ;

beforeEach(() => {
  // A TZ west of UTC, late in the local day: the UTC date is then the next day (2026-10-03),
  // so a request that sends the UTC date fails in every TZ that the test runs in.
  process.env.TZ = "America/Los_Angeles";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T23:30:00"));
  stubResizeObserver(600);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("NetWorthCard", () => {
  it("loads one year to the browser-local date by default and draws the line", async () => {
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<NetWorthCard bookId="1" />);
    expect(screen.getByTestId("net-worth-placeholder")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /Net worth from Aug 31, 2026 to Sep 30, 2026/ })).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/b/1/reports/net-worth-history?startDate=2025-10-02&endDate=2026-10-02",
    );
  });

  it("loads all history to the browser-local date without a start date", async () => {
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<NetWorthCard bookId="1" />);
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/b/1/reports/net-worth-history?endDate=2026-10-02");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("gives screen readers a hidden table with one row for each point", async () => {
    vi.stubGlobal("fetch", respond({ points: [
      ...twoPoints.points,
      { date: "2026-10-02", netWorthCents: -25_000 },
    ] }));
    render(<NetWorthCard bookId="1" />);
    const table = await screen.findByRole("table", { name: "Net worth by date" });
    // The div clips the wide table, so it cannot make the page scroll sideways.
    expect(table.parentElement).toHaveClass("sr-only");
    const rows = within(table).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "DateNet worth",
      "Aug 31, 2026$1,000.00",
      "Sep 30, 2026$1,500.00",
      "Oct 2, 2026−$250.00",
    ]);
  });

  it("shows a message when the request fails", async () => {
    vi.stubGlobal("fetch", respond({ error: "Failed to fetch net worth history" }, false));
    render(<NetWorthCard bookId="1" />);
    expect(await screen.findByText("Could not load net worth history.")).toBeInTheDocument();
  });

  it("shows no chart with fewer than two points", async () => {
    vi.stubGlobal("fetch", respond({ points: [{ date: "2026-10-02", netWorthCents: 5 }] }));
    render(<NetWorthCard bookId="1" />);
    expect(await screen.findByText("Not enough history to chart yet.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("hides the chart and the range group with Hide chart", async () => {
    vi.stubGlobal("fetch", respond(twoPoints));
    render(<NetWorthCard bookId="1" />);
    await screen.findByRole("img");
    expect(screen.getByRole("group", { name: "Range" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Range" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Net worth" })).toBeInTheDocument();
    expect(localStorage.getItem("counterpoise.netWorthChart.hidden")).toBe("true");
  });

  it("renders hidden and sends no request when the stored key is set", () => {
    localStorage.setItem("counterpoise.netWorthChart.hidden", "true");
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<NetWorthCard bookId="1" />);
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Range" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws the groups as stacked areas with By group, and goes back with Total", async () => {
    const fetchMock = respondByView();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<NetWorthCard bookId="1" />);
    await screen.findByRole("img", { name: /^Net worth from/ });
    const view = screen.getByRole("group", { name: "View" });
    expect(within(view).getByRole("button", { name: "Total" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(view).getByRole("button", { name: "By group" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "/api/b/1/reports/net-worth-history?startDate=2025-10-02&endDate=2026-10-02&groupBy=account",
    );
    expect(await screen.findByRole("img", { name: /^Net worth by group from Aug 31, 2026 to Sep 30, 2026/ }))
      .toBeInTheDocument();
    expect(within(view).getByRole("button", { name: "By group" })).toHaveAttribute("aria-pressed", "true");
    expect([...container.querySelectorAll("[data-area-series]")].map((area) => area.getAttribute("data-area-series")))
      .toEqual(["account:1", "account:2"]);
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Bank", "Card", "Net worth"]);
    // The tooltip names its total like the legend and the table.
    fireEvent.mouseMove(container.querySelector("[data-area-overlay]")!, { clientX: 322, clientY: 50 });
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Net worth\$/);
    fireEvent.mouseLeave(container.querySelector("svg")!);
    const table = screen.getByRole("table", { name: "Net worth by date" });
    // The div clips the wide table, so it cannot make the page scroll sideways.
    expect(table.parentElement).toHaveClass("sr-only");
    expect(within(table).getAllByRole("row").map((row) => row.textContent)).toEqual([
      "DateNet worthBankCard",
      "Aug 31, 2026$1,000.00$1,200.00−$200.00",
      "Sep 30, 2026$1,500.00$1,800.00−$300.00",
    ]);

    fireEvent.click(within(view).getByRole("button", { name: "Total" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "/api/b/1/reports/net-worth-history?startDate=2025-10-02&endDate=2026-10-02",
    );
    expect(await screen.findByRole("img", { name: /^Net worth from/ })).toBeInTheDocument();
    expect(container.querySelector("[data-area-series]")).toBeNull();
  });

  it("keeps the group view when the range changes, and does not store the view", async () => {
    const fetchMock = respondByView();
    vi.stubGlobal("fetch", fetchMock);
    render(<NetWorthCard bookId="1" />);
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "By group" }));
    await screen.findByRole("img", { name: /^Net worth by group/ });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "/api/b/1/reports/net-worth-history?endDate=2026-10-02&groupBy=account",
    );
    expect(Object.keys(localStorage)).toEqual([]);
  });
});
