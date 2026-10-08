import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AccountBalanceChart } from "@/components/transactions/AccountBalanceChart";
import { stubResizeObserver } from "@/tests/helpers/resize-observer";

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => isMobileRef.value }));

function respond(body: unknown, ok = true) {
  return vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response,
  );
}

function urls(fetchMock: ReturnType<typeof respond>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

const twoPoints = { points: [
  { date: "2026-08-31", balanceCents: 100_000 },
  { date: "2026-09-30", balanceCents: 150_000 },
] };

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
  isMobileRef.value = false;
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("AccountBalanceChart", () => {
  it("loads one year to the browser-local date by default and draws the line", async () => {
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(screen.getByRole("heading", { name: "Balance" })).toBeInTheDocument();
    expect(screen.getByTestId("account-balance-placeholder")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /^Balance, last year: from \$1,000\.00 on Aug 31, 2026/ }))
      .toBeInTheDocument();
    expect(urls(fetchMock)).toEqual([
      "/api/b/1/accounts/5/balance-history?startDate=2025-10-02&endDate=2026-10-02",
    ]);
  });

  it("sends the start date of each range, and none for All", async () => {
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "5Y" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(urls(fetchMock).slice(1)).toEqual([
      "/api/b/1/accounts/5/balance-history?startDate=2021-10-02&endDate=2026-10-02",
      "/api/b/1/accounts/5/balance-history?endDate=2026-10-02",
    ]);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("fetches again for a new account and for a new refresh key", async () => {
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    await screen.findByRole("img");
    rerender(<AccountBalanceChart bookId="1" accountId={6} accountType="asset" refreshKey={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(urls(fetchMock)[1]).toBe("/api/b/1/accounts/6/balance-history?startDate=2025-10-02&endDate=2026-10-02");
    await screen.findByRole("img");
    rerender(<AccountBalanceChart bookId="1" accountId={6} accountType="asset" refreshKey={1} />);
    // A refresh keeps the line until the new points come.
    expect(screen.getByRole("img")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(urls(fetchMock)[2]).toBe(urls(fetchMock)[1]);
  });

  it("shows the points of the new account only, also when the old response comes last", async () => {
    let resolveOld: (value: Response) => void = () => {};
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/accounts/5/")) {
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ points: [
        { date: "2026-08-31", balanceCents: 700 },
        { date: "2026-09-30", balanceCents: 900 },
      ] }) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    rerender(<AccountBalanceChart bookId="1" accountId={6} accountType="asset" refreshKey={0} />);
    expect(await screen.findByRole("img", { name: /from \$7\.00/ })).toBeInTheDocument();
    resolveOld({ ok: true, status: 200, json: async () => twoPoints } as Response);
    await new Promise((resume) => setTimeout(resume, 0));
    expect(screen.getByRole("img", { name: /from \$7\.00/ })).toBeInTheDocument();
  });

  it("gives screen readers a hidden table with the display sign of the account", async () => {
    vi.stubGlobal("fetch", respond({ points: [
      { date: "2026-08-31", balanceCents: -100_000 },
      { date: "2026-10-02", balanceCents: 2_500 },
    ] }));
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="liability" refreshKey={0} />);
    const table = await screen.findByRole("table", { name: "Balance by date" });
    // The div clips the wide table, so it cannot make the page scroll sideways.
    expect(table.parentElement).toHaveClass("sr-only");
    expect(within(table).getAllByRole("row").map((row) => row.textContent)).toEqual([
      "DateBalance",
      "Aug 31, 2026$1,000.00",
      "Oct 2, 2026−$25.00",
    ]);
  });

  it("is 160 px high above the breakpoint and 120 px below it", async () => {
    vi.stubGlobal("fetch", respond(twoPoints));
    const { unmount } = render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(await screen.findByRole("img")).toHaveAttribute("height", "160");
    unmount();
    isMobileRef.value = true;
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(await screen.findByRole("img")).toHaveAttribute("height", "120");
  });

  it("shows a message when the request fails", async () => {
    vi.stubGlobal("fetch", respond({ error: "Failed to fetch account balance history" }, false));
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(await screen.findByText("Could not load the balance history.")).toBeInTheDocument();
  });

  it("shows no chart with fewer than two points", async () => {
    vi.stubGlobal("fetch", respond({ points: [{ date: "2026-10-02", balanceCents: 5 }] }));
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(await screen.findByText("Not enough history to chart yet.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders hidden and sends no request when the stored key is set", () => {
    localStorage.setItem("counterpoise.accountBalanceChart.hidden", "true");
    const fetchMock = respond(twoPoints);
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountBalanceChart bookId="1" accountId={5} accountType="asset" refreshKey={0} />);
    expect(screen.getByRole("button", { name: "Show chart" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Range" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
