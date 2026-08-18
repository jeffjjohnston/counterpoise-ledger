// tests/app/reports-page.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ReportsPage from "@/app/b/[bookId]/reports/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/reports",
}));

vi.mock("@/components/reports/ReportConfigPanel", () => ({
  ReportConfigPanel: ({
    onGenerate,
    loading,
  }: {
    onGenerate: () => void;
    loading: boolean;
  }) => (
    <div data-testid="report-config-panel">
      <button onClick={onGenerate} disabled={loading}>
        Generate Report
      </button>
    </div>
  ),
}));

vi.mock("@/components/reports/ReportTable", () => ({
  ReportTable: () => <div data-testid="report-table" />,
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

  it("renders ReportConfigPanel", async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("report-config-panel")).toBeInTheDocument();
    });
  });

  it("renders a Generate Report button inside the config panel", async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText("Generate Report")).toBeInTheDocument();
    });
  });
});
