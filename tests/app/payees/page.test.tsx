import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PayeesPage from "@/app/b/[bookId]/payees/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("PayeesPage", () => {
  const getRenderedPayeeOrder = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => {
        const link = within(row).getByRole("link");
        return link.textContent;
      });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters payees by partial name match", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              name: "Blue Bottle Coffee",
              lastTransactionDate: "2024-01-05",
              transactionCount: 4,
            },
            {
              id: 2,
              name: "City Utilities",
              lastTransactionDate: "2024-01-07",
              transactionCount: 2,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeesPage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Blue Bottle Coffee" })).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText("Search payees");
    fireEvent.change(searchInput, { target: { value: "bOTTL" } });

    expect(screen.getByRole("link", { name: "Blue Bottle Coffee" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "City Utilities" })).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "rent" } });

    expect(screen.getByText("No payees match your search.")).toBeInTheDocument();
  });

  it("shows last transaction dates and toggles sorting by column header", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              name: "Charlie Grocer",
              lastTransactionDate: null,
              transactionCount: 2,
            },
            {
              id: 2,
              name: "Alpha Coffee",
              lastTransactionDate: "2024-02-01",
              transactionCount: 4,
            },
            {
              id: 3,
              name: "Bravo Utilities",
              lastTransactionDate: "2024-04-10",
              transactionCount: 2,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeesPage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Alpha Coffee" })).toBeInTheDocument();
    });

    expect(screen.getByText("Feb 1, 2024")).toBeInTheDocument();
    expect(screen.getByText("Apr 10, 2024")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Bravo Utilities",
      "Charlie Grocer",
      "Alpha Coffee",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Last transaction" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Last transaction" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Bravo Utilities",
      "Alpha Coffee",
      "Charlie Grocer",
    ]);
  });
});
