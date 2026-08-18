import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import AccountsPage from "@/app/b/[bookId]/accounts/page";
import { ToastProvider } from "@/components/ui/ToastProvider";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/accounts/AccountForm", () => ({
  AccountForm: ({
    onSubmit,
  }: {
    onSubmit: (data: { name: string; type: string }) => void;
  }) => (
    <button type="button" onClick={() => onSubmit({ name: "Checking", type: "asset" })}>
      submit account form
    </button>
  ),
}));

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    isOpen,
    children,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
  }) => (isOpen ? <div data-testid="modal">{children}</div> : null),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
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
  },
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

describe("AccountsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides investment cash accounts and shows cash balance on the investment row", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return {
          ok: true,
          json: async () => [{ accountId: 1, marketValueCents: 50000 }],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText("Fidelity 401(k)")).toBeInTheDocument();
    });

    expect(screen.queryByText("Fidelity Cash")).not.toBeInTheDocument();
    expect(screen.getByText("Cash $10.00")).toBeInTheDocument();
    expect(screen.getByText("$510.00")).toBeInTheDocument();
  });

  it("renders income accounts without an Other subtype bucket", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => [
            ...accountsPayload,
            {
              id: 4,
              name: "Salary",
              type: "income",
              subtype: null,
              parentId: null,
              isInvestmentCash: false,
              icon: null,
              isActive: true,
              balance: -700000,
            },
          ],
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

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });

    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("shows a category icon for an iconed category row", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => [
            ...accountsPayload,
            {
              id: 4,
              name: "Auto",
              type: "expense",
              subtype: null,
              parentId: null,
              isInvestmentCash: false,
              icon: "🚗",
              isActive: true,
              balance: 50000,
            },
          ],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auto")).toBeInTheDocument();
    });

    expect(screen.getByText("🚗")).toBeInTheDocument();
  });

  it("shows no glyph for an asset account row", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => [
            // Checking (id 3) gets its own icon here, not just a neighbor's
            // icon to not leak. That way the assertion fails if the
            // income/expense type filter in buildCategoryLabelMap is ever
            // deleted (Checking would then resolve its own icon) and also
            // if a renderer ever passes `account.icon` straight through
            // instead of the resolved, type-filtered value.
            ...accountsPayload.map((account) =>
              account.id === 3 ? { ...account, icon: "🏦" } : account
            ),
            {
              id: 4,
              name: "Auto",
              type: "expense",
              subtype: null,
              parentId: null,
              isInvestmentCash: false,
              icon: "🚗",
              isActive: true,
              balance: 50000,
            },
          ],
        } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText("Checking")).toBeInTheDocument();
    });

    const checkingRow = screen
      .getByText("Checking")
      .closest<HTMLElement>('[data-testid="account-row"]');
    expect(checkingRow).not.toBeNull();
    expect(within(checkingRow!).queryByText("🏦")).not.toBeInTheDocument();
  });

  it("shows an error when the accounts fetch fails", async () => {
    // The bug this guards: fetchAccounts called setLoading(false) only on the
    // success path, so a rejected fetch left the page on its skeleton forever.
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    render(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText(/could not load accounts/i)).toBeInTheDocument();
    });

    // The skeleton uses animate-pulse; it must be gone once loading resolves.
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("tells the user when creating an account fails instead of failing silently", async () => {
    // The accounts list loads fine; the create POST is what fails. Routing on
    // URL and method (matching this file's other mocks) keeps the initial
    // load answering with the right shape instead of accidentally handing
    // accountsPayload to the market-values fetch too.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts") && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Account name already used" }),
        } as Response;
      }
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, status: 200, json: async () => accountsPayload } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <ToastProvider>
        <AccountsPage />
      </ToastProvider>
    );

    // Wait for the initial load, then open the create modal (the Modal mock
    // now respects isOpen, so — unlike the other tests in this file — the
    // form isn't on screen until we open it ourselves).
    await screen.findByText("Fidelity 401(k)");
    fireEvent.click(screen.getByRole("button", { name: "New Account" }));

    fireEvent.click(screen.getByRole("button", { name: "submit account form" }));

    // The server's own message, not a generic one — the user needs to know WHY.
    expect(await screen.findByText("Account name already used")).toBeInTheDocument();

    // A failed create must leave the modal open so the user's input isn't lost.
    expect(screen.getByRole("button", { name: "submit account form" })).toBeInTheDocument();
  });
});
