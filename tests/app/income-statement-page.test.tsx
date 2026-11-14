import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import IncomeStatementPage from "@/app/b/[bookId]/reports/income-statement/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/reports/income-statement",
  })
);

// The charts get their own data. These tests are about the page.
vi.mock("@/components/reports/IncomeStatementCharts", () => ({
  IncomeStatementCharts: () => null,
}));

const account = (id: number, name: string, type: "income" | "expense", balance: number) => ({
  id, name, type, subtype: null, parentId: null, isActive: true, balance, children: [],
});

// Another client (an MCP tool, a second tab, a scheduled job) changes the
// book. The server sends the book socket a hint for each changed table, and
// the statement must show the change without a reload.
describe("IncomeStatementPage live updates", () => {
  let accounts: unknown[];
  let periodBalances: Array<{ accountId: number; name: string; type: string; balance: number }>;
  let accountUrls: string[];
  let statementUrls: string[];

  function socket() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  function hint(tables: string[]) {
    act(() => { socket().emit("change", { tables }); });
  }

  function renderLive() {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    return render(
      <BookChangesProvider>
        <IncomeStatementPage />
      </BookChangesProvider>
    );
  }

  beforeEach(() => {
    // The default period ends today. Freeze the clock so that the dates of
    // each period are the same on every day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
    accounts = [account(1, "Salary", "income", -500000), account(2, "Food", "expense", 40000)];
    periodBalances = [
      { accountId: 1, name: "Salary", type: "income", balance: -300000 },
      { accountId: 2, name: "Food", type: "expense", balance: 1000 },
    ];
    accountUrls = [];
    statementUrls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/b/1/accounts")) {
        accountUrls.push(url);
        return { ok: true, status: 200, json: async () => accounts } as Response;
      }
      if (url.startsWith("/api/b/1/reports/income-statement")) {
        statementUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ accounts: periodBalances }) } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Net income is $3,000.00 - $10.00, and the page shows it one time.
  it("shows a split that another client added", async () => {
    renderLive();
    expect(await screen.findByText("$2,990.00")).toBeInTheDocument();

    periodBalances = [periodBalances[0], { ...periodBalances[1], balance: 2500 }];
    hint(["transaction_splits"]);

    expect(await screen.findByText("$2,975.00")).toBeInTheDocument();
    expect(statementUrls).toHaveLength(2);
    // A background reload does not show the loading text.
    expect(screen.queryByText("Loading income statement...")).not.toBeInTheDocument();
  });

  it("removes an account that another client deleted", async () => {
    renderLive();
    expect(await screen.findByText("Food")).toBeInTheDocument();

    accounts = [accounts[0]];
    periodBalances = [periodBalances[0]];
    hint(["accounts"]);

    await waitFor(() => expect(screen.queryByText("Food")).not.toBeInTheDocument());
    expect(screen.getByText("Salary")).toBeInTheDocument();
  });

  it("keeps the selected period", async () => {
    renderLive();
    await screen.findByText("$2,990.00");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "last_year" } });
    await waitFor(() => expect(statementUrls).toHaveLength(2));
    expect(statementUrls[1]).toContain("startDate=2025-01-01");
    await screen.findByText("$2,990.00");

    hint(["transactions"]);

    await waitFor(() => expect(statementUrls).toHaveLength(3));
    expect(statementUrls[2]).toBe(statementUrls[1]);
    expect(screen.getByRole("combobox")).toHaveValue("last_year");
  });

  it("does not get the data again for a table that it does not read", async () => {
    renderLive();
    await screen.findByText("$2,990.00");

    hint(["securities"]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(accountUrls).toHaveLength(1);
    expect(statementUrls).toHaveLength(1);
  });

  it("keeps the statement when a background reload fails", async () => {
    renderLive();
    await screen.findByText("$2,990.00");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetch).mockImplementation(async () =>
      ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response
    );

    hint(["transaction_splits"]);

    await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(screen.getByText("$2,990.00")).toBeInTheDocument();
    expect(screen.getByText("Food")).toBeInTheDocument();
    expect(screen.queryByText("Could not load accounts.")).not.toBeInTheDocument();
    error.mockRestore();
  });
});
