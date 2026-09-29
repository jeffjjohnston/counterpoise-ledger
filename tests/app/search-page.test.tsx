// tests/app/search-page.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SearchPage from "@/app/b/[bookId]/search/page";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/search",
    useSearchParams: () => new URLSearchParams(),
  })
);

describe("SearchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: { items: [], total: 0, truncated: false },
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
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: { items: [], total: 0, truncated: false },
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
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: {
            items: [
              {
                id: 7,
                name: "Vacation Fund Transfer",
                frequency: "monthly",
                nextDate: "2026-08-15",
                businessDaysOnly: true,
                isActive: true,
              },
            ],
            total: 1,
            truncated: false,
          },
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
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: {
            items: [
              {
                id: 8,
                name: "Vacation Fund Transfer",
                frequency: "monthly",
                nextDate: "2026-08-15",
                businessDaysOnly: false,
                isActive: true,
              },
            ],
            total: 1,
            truncated: false,
          },
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

  // Decision 2 exists so a reader can see the 25-row cut. A heading that still
  // reads "Payees (25)" when 112 matched hides exactly what the total and
  // truncated fields were added to expose, so assert the rendered text, not
  // just that the fields arrived.
  it("reports the true total in a bucket heading when the LIMIT truncated it", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: {
            items: [
              { id: 1, name: "Zebra Supply" },
              { id: 2, name: "Zebra Foods" },
            ],
            total: 112,
            truncated: true,
          },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );

    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search transactions/), {
      target: { value: "zebra" },
    });

    await waitFor(
      () => {
        expect(screen.getByText("Payees (2 of 112)")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    expect(screen.queryByText("Payees (2)")).not.toBeInTheDocument();
  });

  it("omits the total from a bucket heading when nothing was truncated", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: {
            items: [
              { id: 1, name: "Zebra Supply" },
              { id: 2, name: "Zebra Foods" },
            ],
            total: 2,
            truncated: false,
          },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );

    render(<SearchPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search transactions/), {
      target: { value: "zebra" },
    });

    await waitFor(
      () => {
        expect(screen.getByText("Payees (2)")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
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
