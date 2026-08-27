import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SyncTokensPage from "@/app/b/[bookId]/sync/tokens/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ bookId: "1" }),
}));

const accountsPayload = [
  {
    id: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    balance: 0,
    hasTransactions: false,
    children: [],
  },
];

describe("SyncTokensPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders token rows with edit actions and no access token column", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 1,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);

    await waitFor(() => {
      expect(screen.getByText("Bank connections")).toBeInTheDocument();
    });

    expect(screen.getByText("Chase")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chase actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Access Token")).not.toBeInTheDocument();
  });

  it("puts Edit and Remove behind a menu, leaving Map accounts inline", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 1,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    await screen.findByText("Chase Bank");

    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("button", { name: "Map accounts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Chase Bank actions/i }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Remove connection/i })).toBeInTheDocument();
  });

  it("names the reconciliation history in the delete confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 1,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    await screen.findByText("Chase Bank");

    fireEvent.click(screen.getByRole("button", { name: /Chase Bank actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove connection/i }));

    const dialogText = await screen.findByText(/reconciliation history/i);
    expect(dialogText).toBeInTheDocument();
    expect(screen.getByText(/already matched, created or ignored/i)).toBeInTheDocument();
  });

  it("adds and removes tokens", async () => {
    const tokens = [
      {
        id: 1,
        financialInstitution: "Chase",
        itemId: "item-1",
        accessTokenMasked: "acce********1234",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        mappedAccountCount: 1,
        totalAccountCount: 1,
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/sync/tokens" && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => [...tokens],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens" && init?.method === "POST") {
        const body = JSON.parse((init.body as string) || "{}");
        tokens.push({
          id: 2,
          financialInstitution: body.financialInstitution,
          itemId: body.itemId,
          accessTokenMasked: "newt********9999",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          mappedAccountCount: 0,
          totalAccountCount: 0,
        });
        return {
          ok: true,
          json: async () => tokens[1],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1" && init?.method === "DELETE") {
        tokens.splice(
          0,
          tokens.length,
          ...tokens.filter((token) => token.id !== 1)
        );
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);

    await waitFor(() => {
      expect(screen.getByText("Chase")).toBeInTheDocument();
    });

    // The page's trigger and the modal's submit share this label, so the
    // modal has to be opened by the first one and submitted by the last.
    fireEvent.click(screen.getAllByRole("button", { name: "Add connection" })[0]);

    fireEvent.change(screen.getByLabelText("Bank name"), {
      target: { value: "Bank of America" },
    });
    fireEvent.change(screen.getByLabelText("Item ID"), {
      target: { value: "item-2" },
    });
    fireEvent.change(screen.getByLabelText("Access Token"), {
      target: { value: "access-token-2" },
    });
    const submitButtons = screen.getAllByRole("button", { name: "Add connection" });
    fireEvent.click(submitButtons[submitButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("Bank of America")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Chase actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove connection/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    await waitFor(() => {
      expect(screen.queryByText("Chase")).not.toBeInTheDocument();
    });
  });

  it("opens Add in a modal that names the script which mints a token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 1,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    await screen.findByText("Chase Bank");

    // the form is not sitting on the page
    expect(screen.queryByLabelText("Access Token")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Add connection/i }));
    expect(await screen.findByText(/npm run plaid:link/)).toBeInTheDocument();
    expect(screen.getByLabelText("Access Token")).toBeInTheDocument();
  });

  it("warns on a connection whose accounts are not all mapped", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Ally Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 2,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    expect(
      await screen.findByText(/1 of 2 accounts mapped/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/will not sync/i)).toBeInTheDocument();
  });

  it("says a fully mapped connection is fully mapped, with no warning", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Ally Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 2,
              totalAccountCount: 2,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    expect(await screen.findByText(/2 of 2 accounts mapped/i)).toBeInTheDocument();
    expect(screen.queryByText(/will not sync/i)).toBeNull();

    // Pinned against the zero-total case below: a fully mapped connection
    // is not flagged for attention.
    expect(screen.getByRole("status", { name: "All accounts mapped" })).toBeInTheDocument();
    expect(screen.getByText("Ally Bank").closest("tr")).not.toHaveClass("bg-warning-subtle");
    expect(screen.getByRole("button", { name: "Map accounts" })).not.toHaveClass("bg-accent");
  });

  it("flags a connection whose accounts have not loaded from the bank yet", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Ally Bank",
              itemId: "item-77",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 0,
              totalAccountCount: 0,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    await screen.findByText("Ally Bank");

    // Not the "0 of 0" tautology — a distinct sentence naming the real state.
    expect(screen.queryByText(/0 of 0 accounts mapped/i)).toBeNull();
    expect(screen.getByText(/not been loaded/i)).toBeInTheDocument();

    // The item id survives even though its own table column is gone.
    expect(screen.getByText("item-77")).toBeInTheDocument();

    // Flagged for attention exactly like a partially mapped connection:
    // amber dot, tinted row, primary action.
    expect(screen.getByRole("status", { name: "Accounts not loaded yet" })).toBeInTheDocument();
    expect(screen.getByText("Ally Bank").closest("tr")).toHaveClass("bg-warning-subtle");
    expect(screen.getByRole("button", { name: "Map accounts" })).toHaveClass("bg-accent");
  });

  it("offers a retry when the Plaid account refresh fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/tokens") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase Bank",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              mappedAccountCount: 1,
              totalAccountCount: 1,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1/accounts?refresh=true") {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Failed to refresh Plaid accounts" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);
    await screen.findByText("Chase Bank");
    fireEvent.click(screen.getAllByRole("button", { name: /Map accounts/i })[0]);

    expect(await screen.findByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("opens assign accounts modal and submits assignments", async () => {
    const tokens = [
      {
        id: 1,
        financialInstitution: "Chase",
        itemId: "item-1",
        accessTokenMasked: "acce********1234",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        mappedAccountCount: 1,
        totalAccountCount: 1,
      },
    ];

    const putSpy = vi.fn();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/sync/tokens" && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => tokens,
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1/accounts?refresh=true") {
        return {
          ok: true,
          json: async () => [
            {
              plaidAccountId: "plaid-account-1",
              name: "Chase Checking",
              officialName: "Personal Checking",
              mask: "0001",
              type: "depository",
              subtype: "checking",
              counterpoiseAccountId: null,
            },
          ],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1/accounts" && init?.method === "PUT") {
        putSpy(JSON.parse((init.body as string) || "{}"));
        return {
          ok: true,
          json: async () => [
            {
              plaidAccountId: "plaid-account-1",
              name: "Chase Checking",
              officialName: "Personal Checking",
              mask: "0001",
              type: "depository",
              subtype: "checking",
              counterpoiseAccountId: 1,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);

    await waitFor(() => {
      expect(screen.getByText("Chase")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Map accounts"));

    await waitFor(() => {
      expect(screen.getByText(/Chase Checking/)).toBeInTheDocument();
    });

    fireEvent.focus(screen.getByLabelText("Counterpoise account"));
    fireEvent.click(screen.getByText("Checking"));
    fireEvent.click(screen.getByText("Save assignments"));

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    expect(putSpy.mock.calls[0][0]).toEqual({
      assignments: [
        {
          plaidAccountId: "plaid-account-1",
          counterpoiseAccountId: 1,
        },
      ],
    });
  });

  it("refreshes the mapping counts after loading accounts and after saving", async () => {
    // The row's "N of M accounts mapped" is the branch's headline unblocking
    // fix. It was computed once at page load and never re-read, so the two
    // operations that change it both left it reporting the state before the
    // fix: the ?refresh=true load (which upserts plaidAccounts server-side)
    // and the save itself.
    const tokenPages = [
      { mappedAccountCount: 0, totalAccountCount: 0 },
      { mappedAccountCount: 0, totalAccountCount: 1 },
      { mappedAccountCount: 1, totalAccountCount: 1 },
    ];
    let tokenGets = 0;
    let mapped = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/sync/tokens" && (!init || init.method === "GET")) {
        const counts = tokenPages[Math.min(tokenGets, tokenPages.length - 1)];
        tokenGets += 1;
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              financialInstitution: "Chase",
              itemId: "item-1",
              accessTokenMasked: "acce********1234",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              ...counts,
            },
          ],
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return { ok: true, json: async () => accountsPayload } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1/accounts?refresh=true") {
        return {
          ok: true,
          json: async () => [
            {
              plaidAccountId: "plaid-account-1",
              name: "Chase Checking",
              officialName: "Personal Checking",
              mask: "0001",
              type: "depository",
              subtype: "checking",
              counterpoiseAccountId: null,
            },
          ],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1/accounts" && init?.method === "PUT") {
        mapped = true;
        return {
          ok: true,
          json: async () => [
            {
              plaidAccountId: "plaid-account-1",
              name: "Chase Checking",
              officialName: "Personal Checking",
              mask: "0001",
              type: "depository",
              subtype: "checking",
              counterpoiseAccountId: 1,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);

    await screen.findByText(/Accounts have not been loaded from the bank yet/);

    fireEvent.click(screen.getByText("Map accounts"));

    // The refresh loaded them; the row must stop claiming otherwise.
    await waitFor(() => {
      expect(screen.getByText(/0 of 1 accounts mapped/)).toBeInTheDocument();
    });

    fireEvent.focus(screen.getByLabelText("Counterpoise account"));
    fireEvent.click(screen.getByText("Checking"));
    fireEvent.click(screen.getByText("Save assignments"));

    await waitFor(() => {
      expect(mapped).toBe(true);
      expect(screen.getByText(/1 of 1 accounts mapped/)).toBeInTheDocument();
    });
  });

  it("edits token details from the actions menu", async () => {
    const putSpy = vi.fn();
    const tokens = [
      {
        id: 1,
        financialInstitution: "Chase",
        itemId: "item-1",
        accessTokenMasked: "acce********1234",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        mappedAccountCount: 1,
        totalAccountCount: 1,
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/sync/tokens" && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => [...tokens],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/1" && init?.method === "PUT") {
        const body = JSON.parse((init.body as string) || "{}");
        putSpy(body);
        tokens.splice(0, tokens.length, {
          ...tokens[0],
          financialInstitution: body.financialInstitution,
          itemId: body.itemId,
        });
        return {
          ok: true,
          json: async () => ({
            ...tokens[0],
          }),
        } as Response;
      }

      if (url.startsWith("/api/b/1/accounts")) {
        return {
          ok: true,
          json: async () => accountsPayload,
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncTokensPage />);

    await waitFor(() => {
      expect(screen.getByText("Chase")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Chase actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(document.getElementById("edit-financialInstitution") as Element, {
      target: { value: "Wells Fargo" },
    });
    fireEvent.change(document.getElementById("edit-itemId") as Element, {
      target: { value: "item-2" },
    });
    fireEvent.change(screen.getByLabelText("New access token"), {
      target: { value: "updated-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    expect(putSpy.mock.calls[0][0]).toEqual({
      financialInstitution: "Wells Fargo",
      itemId: "item-2",
      accessToken: "updated-token",
    });
    expect(screen.getByText("Wells Fargo")).toBeInTheDocument();
  });
});
