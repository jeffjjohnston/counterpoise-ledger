import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import HomePage from "@/app/b/[bookId]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const accountsPayload = [
  {
    id: 1,
    name: "Fidelity 401(k)",
    type: "asset",
    subtype: "investment",
    parentId: null,
    isInvestmentCash: false,
    icon: null,
    isActive: true,
    balance: 50000,
    children: [
      {
        id: 2,
        name: "Fidelity Cash",
        type: "asset",
        subtype: "cash",
        parentId: 1,
        isInvestmentCash: true,
        icon: null,
        isActive: true,
        balance: 1000,
      },
    ],
  },
  {
    id: 3,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isInvestmentCash: false,
    icon: null,
    isActive: true,
    balance: 250000,
  },
];

describe("HomePage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides investment cash accounts in the assets list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("Fidelity 401(k)")).toBeInTheDocument();
    });

    expect(screen.queryByText("Fidelity Cash")).not.toBeInTheDocument();
    expect(screen.getByText("Cash $10.00")).toBeInTheDocument();
  });

  it("uses book-scoped transaction links for account rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Checking" })).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Checking" })).toHaveAttribute(
      "href",
      "/b/1/transactions?accountId=3"
    );
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("shows payee name instead of description in recent transactions", async () => {
    const transactionsPayload = [
      {
        id: 10,
        date: "2026-03-01",
        description: "Monthly groceries",
        payeeId: 1,
        payee: { id: 1, name: "Whole Foods", bookId: 1 },
        splits: [
          { id: 1, amount: -5000, account: { id: 3, name: "Checking", type: "asset" } },
          { id: 2, amount: 5000, account: { id: 4, name: "Groceries", type: "expense" } },
        ],
        investmentSplits: [],
      },
      {
        id: 11,
        date: "2026-03-02",
        description: "ATM withdrawal",
        payeeId: null,
        payee: null,
        splits: [
          { id: 3, amount: -10000, account: { id: 3, name: "Checking", type: "asset" } },
          { id: 4, amount: 10000, account: { id: 5, name: "Cash", type: "asset" } },
        ],
        investmentSplits: [],
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/transactions")) {
        return { ok: true, json: async () => transactionsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => {
      // Transaction with payee: shows payee name as primary label
      expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    });

    // Transaction without payee: falls back to description
    expect(screen.getByText("ATM withdrawal")).toBeInTheDocument();

    // Description should NOT appear as the primary label when payee exists
    expect(screen.queryByText("Monthly groceries")).not.toBeInTheDocument();
  });
});
