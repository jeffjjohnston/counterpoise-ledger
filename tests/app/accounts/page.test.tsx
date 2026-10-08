import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, afterEach } from "vitest";
import AccountsPage from "@/app/b/[bookId]/accounts/page";
import { ToastProvider } from "@/components/ui/ToastProvider";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

let bookRoleValue: { canWrite: boolean; isOwner: boolean; role: string } = {
  canWrite: true,
  isOwner: true,
  role: "owner",
};

vi.mock("@/components/BookRoleProvider", () => ({
  useBookRole: () => bookRoleValue,
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
    bookRoleValue = { canWrite: true, isOwner: true, role: "owner" };
  });

  it("hides the empty-state create action from a viewer with no accounts", async () => {
    bookRoleValue = { canWrite: false, isOwner: false, role: "viewer" };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith("/api/b/1/investments/account-values")) {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountsPage />);

    expect(await screen.findByText("No accounts yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create your first account" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Create your first account" })
    ).not.toBeInTheDocument();
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

  describe("account search", () => {
    const searchPayload = [
      ...accountsPayload,
      {
        id: 4,
        name: "Auto",
        type: "expense",
        subtype: null,
        parentId: null,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: 0,
      },
      {
        id: 5,
        name: "Auto:Fuel",
        type: "expense",
        subtype: null,
        parentId: 4,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: 4000,
      },
      {
        id: 6,
        name: "Auto:Insurance",
        type: "expense",
        subtype: null,
        parentId: 4,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: 9000,
      },
      // A child name does not always contain the parent name: the API
      // accepts it, and a rename of the parent changes only that row.
      {
        id: 7,
        name: "Car",
        type: "expense",
        subtype: null,
        parentId: null,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: 0,
      },
      {
        id: 8,
        name: "Tolls",
        type: "expense",
        subtype: null,
        parentId: 7,
        isInvestmentCash: false,
        icon: null,
        isActive: true,
        balance: 1500,
      },
    ];

    const renderWithAccounts = async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.startsWith("/api/b/1/accounts")) {
            return { ok: true, json: async () => searchPayload } as Response;
          }
          if (url.startsWith("/api/b/1/investments/account-values")) {
            return {
              ok: true,
              json: async () => [{ accountId: 1, marketValueCents: 50000 }],
            } as Response;
          }
          throw new Error(`Unexpected fetch url: ${url}`);
        })
      );
      render(<AccountsPage />);
      await screen.findByText("Checking");
      return screen.getByLabelText("Search accounts");
    };

    it("filters the accounts by name, ignoring case", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.change(searchInput, { target: { value: "cHECK" } });

      expect(screen.getByText("Checking")).toBeInTheDocument();
      expect(screen.queryByText("Fidelity 401(k)")).not.toBeInTheDocument();
      expect(screen.queryByText("Fuel")).not.toBeInTheDocument();
    });

    it("keeps the parent of a matching sub-account", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.change(searchInput, { target: { value: "fuel" } });

      // The parent stays, so the match keeps its place in the tree.
      expect(screen.getByText("Auto")).toBeInTheDocument();
      expect(screen.getByText("Fuel")).toBeInTheDocument();
      expect(screen.queryByText("Insurance")).not.toBeInTheDocument();
      expect(screen.queryByText("Checking")).not.toBeInTheDocument();
    });

    it("keeps the sub-accounts of a matching parent", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.change(searchInput, { target: { value: "car" } });

      expect(screen.getByText("Tolls")).toBeInTheDocument();
      // Without its sub-account, the parent looks empty and offers Delete.
      const carRow = screen
        .getByText("Car")
        .closest<HTMLElement>('[data-testid="account-row"]');
      expect(carRow).not.toBeNull();
      expect(
        within(carRow!).queryByRole("button", { name: "Delete" })
      ).not.toBeInTheDocument();
    });

    it("keeps the cash balance of a matching investment account", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.change(searchInput, { target: { value: "401" } });

      expect(screen.getByText("Fidelity 401(k)")).toBeInTheDocument();
      expect(screen.getByText("Cash $10.00")).toBeInTheDocument();
      expect(screen.getByText("$510.00")).toBeInTheDocument();
    });

    it("shows a match in a collapsed subtype group", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.click(screen.getByRole("button", { name: /Bank Account/ }));
      expect(screen.queryByText("Checking")).not.toBeInTheDocument();

      fireEvent.change(searchInput, { target: { value: "checking" } });

      expect(screen.getByText("Checking")).toBeInTheDocument();
    });

    it("tells the user when no account matches", async () => {
      const searchInput = await renderWithAccounts();

      fireEvent.change(searchInput, { target: { value: "mortgage" } });

      expect(screen.getByText("No accounts match your search.")).toBeInTheDocument();
      expect(screen.queryByText("No accounts yet")).not.toBeInTheDocument();
    });
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
