// tests/app/search-page.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SearchPage from "@/app/b/[bookId]/search/page";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/search",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

describe("SearchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: [],
          payees: [],
          recurringRules: [],
        })
      )
    );
  });

  it("renders the search page with title and input", () => {
    render(<SearchPage />);
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search transactions/)
    ).toBeInTheDocument();
  });

  it("shows no results message after search with debounce", async () => {
    render(<SearchPage />);
    const input = screen.getByPlaceholderText(/Search transactions/);
    fireEvent.change(input, { target: { value: "nonexistent" } });

    await waitFor(
      () => {
        expect(screen.getByText(/No results found/)).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it("displays transactions when results are returned", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [
            {
              id: 1,
              date: "2024-01-15",
              description: "Coffee Shop",
              checkNumber: null,
              payee: { id: 10, name: "Starbucks" },
              splits: [
                {
                  accountId: 1,
                  accountName: "Checking",
                  amount: 500,
                  isFavorite: true,
                  subtype: "bank",
                  isInvestmentCash: false,
                  icon: null,
                },
              ],
            },
          ],
          accounts: [],
          payees: [],
          recurringRules: [],
        })
      )
    );

    render(<SearchPage />);
    const input = screen.getByPlaceholderText(/Search transactions/);
    fireEvent.change(input, { target: { value: "starbucks" } });

    await waitFor(
      () => {
        expect(screen.getByText("Starbucks")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // 2026-08-15 is a Saturday. A businessDaysOnly rule is observed on Monday
  // 2026-08-17, and search must agree with the recurring page about that.
  it("shows the observed next date for a business-day-only rule", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: [],
          payees: [],
          recurringRules: [
            {
              id: 7,
              name: "Vacation Fund Transfer",
              frequency: "monthly",
              nextDate: "2026-08-15",
              businessDaysOnly: true,
              isActive: true,
            },
          ],
        })
      )
    );

    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search transactions/), {
      target: { value: "vacation" },
    });

    await waitFor(
      () => {
        expect(screen.getByText("Vacation Fund Transfer")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    expect(screen.getByText("Aug 17, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Aug 15, 2026")).not.toBeInTheDocument();
  });

  it("shows the scheduled next date when the rule is not business-day only", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: [],
          payees: [],
          recurringRules: [
            {
              id: 8,
              name: "Vacation Fund Transfer",
              frequency: "monthly",
              nextDate: "2026-08-15",
              businessDaysOnly: false,
              isActive: true,
            },
          ],
        })
      )
    );

    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search transactions/), {
      target: { value: "vacation" },
    });

    await waitFor(
      () => {
        expect(screen.getByText("Vacation Fund Transfer")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    expect(screen.getByText("Aug 15, 2026")).toBeInTheDocument();
  });

  it("does not call fetch when query is empty", async () => {
    vi.useFakeTimers();
    try {
      render(<SearchPage />);
      // No input change — simulate debounce window passing; fetch should not be called
      await vi.advanceTimersByTimeAsync(400);
      expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
