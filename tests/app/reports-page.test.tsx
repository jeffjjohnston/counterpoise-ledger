// tests/app/reports-page.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReportsPage from "@/app/b/[bookId]/reports/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import type { ReportConfig } from "@/components/reports/ReportConfigPanel";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/reports",
  })
);

vi.mock("@/components/reports/ReportConfigPanel", () => ({
  ReportConfigPanel: ({
    config,
    onChange,
    onGenerate,
    loading,
  }: {
    config: ReportConfig;
    onChange: (config: ReportConfig) => void;
    onGenerate: () => void;
    loading: boolean;
  }) => (
    <div data-testid="report-config-panel">
      <button onClick={() => onChange({ ...config, startDate: "2020-01-01" })}>
        Edit start date
      </button>
      <button onClick={onGenerate} disabled={loading}>
        Generate Report
      </button>
    </div>
  ),
}));

vi.mock("@/components/reports/ReportTable", () => ({
  ReportTable: ({ grandTotal }: { grandTotal: number }) => (
    <div data-testid="report-table">{grandTotal}</div>
  ),
}));

vi.mock("@/components/reports/ReportChart", () => ({
  ReportChart: () => null,
}));

describe("ReportsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/accounts")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 1,
                name: "Income",
                type: "income",
                parentId: null,
                isActive: true,
                balance: 0,
                children: [],
              },
            ])
          )
        );
      }
      if (url.includes("/reports/data")) {
        return Promise.resolve(
          new Response(JSON.stringify({ splits: [], accounts: [] }))
        );
      }
      return Promise.resolve(new Response("{}"));
    });
  });

  it("renders the page title", async () => {
    render(<ReportsPage />);
    expect(screen.getByText("Reports")).toBeInTheDocument();
  });

  it("fetches accounts and report data on mount", async () => {
    render(<ReportsPage />);

    await waitFor(() => {
      const calls = vi.mocked(global.fetch).mock.calls.map(
        (c) => c[0] as string
      );
      expect(calls.some((u) => u.includes("/accounts"))).toBe(true);
      expect(calls.some((u) => u.includes("/reports/data"))).toBe(true);
    });
  });

  // Another client (an MCP tool, a second tab, a scheduled job) changes the
  // book. The server sends the book socket a hint for each changed table, and
  // the report must show the change without a reload.
  describe("live updates", () => {
    const split = (amount: number) => ({
      splitId: 1, transactionId: 1, date: "2026-02-01", amount,
      accountId: 1, accountName: "Food", accountType: "expense",
      accountParentId: null, payeeId: null, payeeName: null,
    });
    let reportSplits: unknown[];
    let reportUrls: string[];

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
          <ReportsPage />
        </BookChangesProvider>
      );
    }

    beforeEach(() => {
      reportSplits = [split(1000)];
      reportUrls = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/reports/data")) {
          reportUrls.push(url);
          const accounts = [{ id: 1, name: "Food", type: "expense", parentId: null }];
          return new Response(JSON.stringify({ splits: reportSplits, accounts }));
        }
        return new Response("[]");
      }));
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("shows a split that another client added", async () => {
      renderLive();
      await waitFor(() => expect(screen.getByTestId("report-table")).toHaveTextContent("1000"));

      reportSplits = [split(1000), split(500)];
      hint(["transaction_splits"]);

      await waitFor(() => expect(screen.getByTestId("report-table")).toHaveTextContent("1500"));
      expect(reportUrls).toHaveLength(2);
    });

    it("does not get the report again for a table that it does not read", async () => {
      renderLive();
      await screen.findByTestId("report-table");

      hint(["securities"]);
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(reportUrls).toHaveLength(1);
    });

    it("runs the last query again, not a config that the user did not apply", async () => {
      renderLive();
      await screen.findByTestId("report-table");

      fireEvent.click(screen.getByRole("button", { name: "Edit start date" }));
      hint(["transactions"]);

      await waitFor(() => expect(reportUrls).toHaveLength(2));
      expect(reportUrls[1]).toBe(reportUrls[0]);
      expect(reportUrls[1]).not.toContain("2020-01-01");
      // The report stays on the screen.
      expect(screen.getByTestId("report-table")).toBeInTheDocument();
    });

    it("shows an error, not the old report, when a new query fails", async () => {
      renderLive();
      await waitFor(() => expect(screen.getByTestId("report-table")).toHaveTextContent("1000"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const serve = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input) =>
        String(input).includes("/reports/data") ? new Response("{}", { status: 500 }) : serve(input)
      );

      fireEvent.click(screen.getByRole("button", { name: "Edit start date" }));
      fireEvent.click(screen.getByRole("button", { name: "Generate Report" }));

      // The old report does not belong to the new config.
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the report.");
      expect(screen.queryByTestId("report-table")).not.toBeInTheDocument();

      // A background reload of the new query also fails. The message stays.
      hint(["transaction_splits"]);
      await waitFor(() => expect(reportUrls.length + error.mock.calls.length).toBeGreaterThan(2));
      expect(screen.getByRole("alert")).toBeInTheDocument();

      // The next Generate that succeeds shows the report again.
      vi.mocked(fetch).mockImplementation(serve);
      fireEvent.click(screen.getByRole("button", { name: "Generate Report" }));
      await waitFor(() => expect(screen.getByTestId("report-table")).toHaveTextContent("1000"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      error.mockRestore();
    });

    it("keeps the report when a background reload fails", async () => {
      renderLive();
      await waitFor(() => expect(screen.getByTestId("report-table")).toHaveTextContent("1000"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(fetch).mockImplementation(async () => new Response("{}", { status: 500 }));

      hint(["transaction_splits"]);

      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(screen.getByTestId("report-table")).toHaveTextContent("1000");
      error.mockRestore();
    });
  });
});
