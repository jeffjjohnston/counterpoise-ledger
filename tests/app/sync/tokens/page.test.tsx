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
      expect(screen.getByText("Manage Sync Tokens")).toBeInTheDocument();
    });

    expect(screen.getByText("Chase")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Access Token")).not.toBeInTheDocument();
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
      },
    ];

    vi.stubGlobal("confirm", vi.fn(() => true));

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

    fireEvent.change(screen.getByLabelText("Financial Institution"), {
      target: { value: "Bank of America" },
    });
    fireEvent.change(screen.getByLabelText("Item ID"), {
      target: { value: "item-2" },
    });
    fireEvent.change(screen.getByLabelText("Access Token"), {
      target: { value: "access-token-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Token" }));

    await waitFor(() => {
      expect(screen.getByText("Bank of America")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("Remove")[0]);
    await waitFor(() => {
      expect(screen.queryByText("Chase")).not.toBeInTheDocument();
    });
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

    fireEvent.click(screen.getByText("Assign Accounts"));

    await waitFor(() => {
      expect(screen.getByText(/Chase Checking/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Counterpoise Account"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByText("Save Assignments"));

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

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(document.getElementById("edit-financialInstitution") as Element, {
      target: { value: "Wells Fargo" },
    });
    fireEvent.change(document.getElementById("edit-itemId") as Element, {
      target: { value: "item-2" },
    });
    fireEvent.change(screen.getByLabelText("New Access Token"), {
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
