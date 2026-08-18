import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import RealizedGainsPage from "@/app/b/[bookId]/reports/realized-gains/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/reports/realized-gains",
}));

const payload = {
  rows: [
    {
      sellDate: "2024-09-01", transactionId: 3, securityId: 1,
      securitySymbol: "VTI", securityName: "Vanguard Total",
      accountId: 2, accountName: "Brokerage",
      sharesMicros: 100_000_000, acquiredDate: "2022-01-01",
      proceedsCents: 300_000, basisCents: 100_000, gainCents: 200_000, term: "long",
    },
    {
      sellDate: "2024-09-01", transactionId: 3, securityId: 1,
      securitySymbol: "VTI", securityName: "Vanguard Total",
      accountId: 2, accountName: "Brokerage",
      sharesMicros: 20_000_000, acquiredDate: "2024-05-01",
      proceedsCents: 60_000, basisCents: 40_000, gainCents: 20_000, term: "short",
    },
  ],
  totals: {
    shortTermGainCents: 20_000, longTermGainCents: 200_000,
    proceedsCents: 360_000, basisCents: 140_000, unknownBasisRows: 0,
  },
};

// The page issues two independent requests: the investment-account list behind
// the Account filter, and the report itself. A mock answering both with the same
// body would hand the report payload to flattenAccounts, so every mock here
// routes on the URL rather than responding blindly.
const ACCOUNTS = [
  { id: 2, name: "Brokerage", type: "asset", subtype: "investment", children: [] },
  { id: 7, name: "IRA", type: "asset", subtype: "investment", children: [] },
  // Not an investment account — must not appear as a filter option.
  { id: 9, name: "Checking", type: "asset", subtype: "bank", children: [] },
];

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

type ReportResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

const isAccountsRequest = (url: string) => url.includes("/accounts");

// async so a responder may return a Response, a Promise<Response>, or throw
// synchronously (the abort case) and still present a fetch-shaped Promise.
function routeFetch(report: ReportResponder) {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (isAccountsRequest(String(url))) return okJson(ACCOUNTS);
    return report(String(url), init);
  }) as unknown as typeof fetch;
}

const reportOk = (body: unknown): ReportResponder => () => okJson(body);

describe("RealizedGainsPage", () => {
  beforeEach(() => {
    // The page defaults its range to currentTaxYear(), whose end date is TODAY.
    // A test that types a fixed "To" date is therefore a no-op on the one real
    // day that already matches it — the field never changes, so no refetch
    // fires. That is not hypothetical: this suite went red on 2026-08-12
    // because a test below types 08/12/2026. Freeze the clock so the default
    // range is the same on every day of the year.
    //
    // Only Date is faked: bare useFakeTimers() would also capture the timers
    // waitFor depends on (and postgres.js elsewhere in the suite).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
    global.fetch = routeFetch(reportOk(payload));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one row per allocation with its term", async () => {
    render(<RealizedGainsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("VTI")).toHaveLength(2);
    });
    expect(screen.getByText("Long")).toBeInTheDocument();
    expect(screen.getByText("Short")).toBeInTheDocument();
  });

  it("shows short-term and long-term totals separately", async () => {
    render(<RealizedGainsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("short-term-total")).toHaveTextContent("$200.00");
    });
    expect(screen.getByTestId("long-term-total")).toHaveTextContent("$2,000.00");
  });

  it("flags unknown-basis rows and shows the reconciliation banner", async () => {
    global.fetch = routeFetch(
      reportOk({
        rows: [
          {
            sellDate: "2024-09-01", transactionId: 4, securityId: 1,
            securitySymbol: "VXUS", securityName: "Vanguard Total Intl",
            accountId: 2, accountName: "Brokerage",
            sharesMicros: 10_000_000, acquiredDate: null,
            proceedsCents: 50_000, basisCents: null, gainCents: null, term: "unknown",
          },
        ],
        totals: {
          shortTermGainCents: 0, longTermGainCents: 0,
          proceedsCents: 50_000, basisCents: 0, unknownBasisRows: 1,
        },
      })
    );

    render(<RealizedGainsPage />);

    await waitFor(() => {
      expect(screen.getByText("Basis unknown")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/1 disposal could not be matched to a lot/i)
    ).toBeInTheDocument();
    // Basis and gain are unknown for this row — shown as a dash, not $0.00
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a loss as a negative amount, not a confusing positive", async () => {
    global.fetch = routeFetch(
      reportOk({
        rows: [
          {
            sellDate: "2024-09-01", transactionId: 5, securityId: 1,
            securitySymbol: "BND", securityName: "Vanguard Bond",
            accountId: 2, accountName: "Brokerage",
            sharesMicros: 10_000_000, acquiredDate: "2023-01-01",
            proceedsCents: 40_000, basisCents: 90_000, gainCents: -50_000, term: "long",
          },
        ],
        totals: {
          shortTermGainCents: 0, longTermGainCents: -50_000,
          proceedsCents: 40_000, basisCents: 90_000, unknownBasisRows: 0,
        },
      })
    );

    render(<RealizedGainsPage />);

    await waitFor(() => {
      expect(screen.getByText("BND")).toBeInTheDocument();
    });

    // formatCurrency renders a true minus sign (U+2212), not a hyphen, and the
    // Gain/Loss cell is colored to distinguish a loss from a gain.
    const row = screen.getByText("BND").closest("tr")!;
    const gainCell = within(row).getByText("−$500.00");
    expect(gainCell).toHaveClass("text-fg-danger");
  });

  it("shows a distinct error state instead of an endless Loading or a misleading empty table", async () => {
    global.fetch = routeFetch(
      () => ({ ok: false, json: async () => ({ error: "boom" }) }) as Response
    );

    render(<RealizedGainsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load realized gains. Please try again.")
      ).toBeInTheDocument();
    });
    // The table body must say the request failed — not still claim to be loading,
    // and not read as "you have no disposals," which is the more dangerous
    // misread for a tax report.
    expect(screen.getByText("Unable to load realized gains.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No disposals in this date range.")).not.toBeInTheDocument();
  });

  it("ignores a stale response when the date range changes before the first request settles", async () => {
    const staleResult = {
      rows: [],
      totals: {
        shortTermGainCents: 10_000, longTermGainCents: 0,
        proceedsCents: 0, basisCents: 0, unknownBasisRows: 0,
      },
    };
    const freshResult = {
      rows: [],
      totals: {
        shortTermGainCents: 20_000, longTermGainCents: 0,
        proceedsCents: 0, basisCents: 0, unknownBasisRows: 0,
      },
    };

    // Held open until the test explicitly releases it, simulating a slow first
    // request that would otherwise resolve after the faster second one.
    let releaseStale: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });

    // Counts report requests only — the account-list request is incidental here
    // and would otherwise skew the call-ordering assertions below.
    let reportCalls = 0;
    global.fetch = routeFetch((_url, init) => {
      reportCalls += 1;
      const isFirstCall = reportCalls === 1;
      const body = isFirstCall ? staleResult : freshResult;
      const signal = init?.signal;

      const respond = (): Response => {
        // A real aborted fetch rejects rather than resolving — the page relies on
        // this to tell a cancelled request apart from a real answer.
        if (signal?.aborted) {
          throw Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          });
        }
        return okJson(body);
      };

      return isFirstCall ? staleGate.then(respond) : Promise.resolve(respond());
    });

    render(<RealizedGainsPage />);
    await waitFor(() => expect(reportCalls).toBe(1));

    // Change the date range before the first (stale) request resolves. This must
    // abort it and fire a second request for the new range.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "08/12/2026" } });
    await waitFor(() => expect(reportCalls).toBe(2));
    await waitFor(() => {
      expect(screen.getByTestId("short-term-total")).toHaveTextContent("$200.00");
    });

    // Now let the stale first request settle. Because it was aborted, it must
    // reject rather than silently overwriting the fresh totals already on screen.
    releaseStale();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByTestId("short-term-total")).toHaveTextContent("$200.00");
  });

  it("ignores a Firefox-shaped abort (TypeError, not AbortError) instead of painting an error over fresher data", async () => {
    const freshResult = {
      rows: [],
      totals: {
        shortTermGainCents: 20_000, longTermGainCents: 0,
        proceedsCents: 0, basisCents: 0, unknownBasisRows: 0,
      },
    };

    // Held open until the test explicitly rejects it, simulating a first
    // request whose underlying fetch doesn't settle until after it's aborted.
    let rejectStale: (err: unknown) => void = () => {};
    const staleGate = new Promise<Response>((_resolve, reject) => {
      rejectStale = reject;
    });

    // Counts report requests only — the account-list request is incidental here
    // and would otherwise skew the call-ordering assertions below.
    let reportCalls = 0;
    global.fetch = routeFetch(() => {
      reportCalls += 1;
      const isFirstCall = reportCalls === 1;
      return isFirstCall ? staleGate : Promise.resolve(okJson(freshResult));
    });

    render(<RealizedGainsPage />);
    await waitFor(() => expect(reportCalls).toBe(1));

    // Change the date range before the first (stale) request resolves. This must
    // abort it and fire a second request for the new range.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "08/12/2026" } });
    await waitFor(() => expect(reportCalls).toBe(2));
    await waitFor(() => {
      expect(screen.getByTestId("short-term-total")).toHaveTextContent("$200.00");
    });

    // Now let the stale first request settle — but unlike the sibling test above,
    // it doesn't reject with an AbortError-named DOMException. This is what
    // Firefox reports for an aborted body read, and what any body truncated
    // mid-stream rejects with regardless of browser. Name-based matching alone
    // would miss this and fall through to the generic error handler, painting
    // an error over the fresh totals already on screen.
    rejectStale(new TypeError("NetworkError when attempting to fetch resource."));
    // The mock route is itself an async function and the rejection crosses
    // several more promise boundaries (apiFetch's await fetch(...), apiGet,
    // the .catch() in the page) than the sibling test's single .then(respond)
    // hop, so flush a macrotask rather than counting microtask ticks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      screen.queryByText("Failed to load realized gains. Please try again.")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("short-term-total")).toHaveTextContent("$200.00");
  });

  it("offers only investment accounts in the filter, defaulting to all", async () => {
    render(<RealizedGainsPage />);

    const select = await screen.findByLabelText("Account");
    await waitFor(() => {
      expect(within(select).getByText("Brokerage")).toBeInTheDocument();
    });

    expect(within(select).getByText("IRA")).toBeInTheDocument();
    // Lots exist only on investment accounts, so a bank account would be an
    // option guaranteed to return nothing.
    expect(within(select).queryByText("Checking")).not.toBeInTheDocument();
    expect(select).toHaveValue("");
  });

  it("scopes the report to the selected account", async () => {
    const requested: string[] = [];
    global.fetch = routeFetch((url) => {
      requested.push(url);
      return okJson(payload);
    });

    render(<RealizedGainsPage />);
    await waitFor(() => expect(requested).toHaveLength(1));
    // The default view is unscoped — an accountId of any kind here would mean
    // the report silently opened filtered to one account.
    expect(requested[0]).not.toContain("accountId");

    fireEvent.change(await screen.findByLabelText("Account"), { target: { value: "7" } });

    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]).toContain("accountId=7");
    // Selecting an account must not drop the date range it is scoped within.
    expect(requested[1]).toContain("startDate=");
    expect(requested[1]).toContain("endDate=");
  });
});
