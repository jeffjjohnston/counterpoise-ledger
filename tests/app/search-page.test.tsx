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
