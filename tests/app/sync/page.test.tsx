import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SyncPage from "@/app/b/[bookId]/sync/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/sync/ReconciliationModal", () => ({
  ReconciliationModal: ({
    isOpen,
    row,
  }: {
    isOpen: boolean;
    row: { plaidAccountName: string } | null;
  }) => (isOpen ? <div>Reconciling {row?.plaidAccountName}</div> : null),
}));

describe("SyncPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders grouped assigned accounts with a manage tokens link", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 12,
              financialInstitution: "Chase",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-2",
              plaidAccountName: "Chase Savings",
              counterpoiseAccountId: 2,
              counterpoiseAccountName: "Savings",
              lastSyncedAt: null,
              pendingCount: 2,
              reviewCount: 1,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sync" })).toBeInTheDocument();
    });

    expect(screen.getByText("Manage Tokens")).toBeInTheDocument();
    expect(screen.getByText("Chase")).toBeInTheDocument();
    expect(screen.getByText("Chase Checking")).toBeInTheDocument();
    expect(screen.getByText("Chase Savings")).toBeInTheDocument();
    expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
    expect(screen.getByText("To Review")).toBeInTheDocument();
    expect(screen.getByText("Pending 2")).toBeInTheDocument();
    expect(screen.getByText("Review 1")).toBeInTheDocument();
  });

  it("shows the last sync failure reason when present", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: "ITEM_LOGIN_REQUIRED",
              pendingCount: 0,
              reviewCount: 0,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    await waitFor(() => {
      expect(screen.getByText(/Last sync failed: ITEM_LOGIN_REQUIRED/)).toBeInTheDocument();
    });
  });

  it("renders an empty state when there are no mappings", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No account mappings yet. Add a token and assign accounts to start syncing.")
      ).toBeInTheDocument();
    });
  });

  it("syncs all accounts under a token and refreshes", async () => {
    const rows = [
      {
        plaidLinkId: 11,
        financialInstitution: "Chase",
        tokenId: 5,
        itemId: "item-1",
        plaidAccountId: "plaid-1",
        plaidAccountName: "Chase Checking",
        counterpoiseAccountId: 1,
        counterpoiseAccountName: "Checking",
        lastSyncedAt: null as string | null,
        pendingCount: 0,
        reviewCount: 0,
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [...rows],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/5/sync" && init?.method === "POST") {
        rows[0] = {
          ...rows[0],
          pendingCount: 1,
          lastSyncedAt: "2026-02-09T10:30:00.000Z",
        };
        return {
          ok: true,
          json: async () => ({ synced: { added: 1, modified: 0, removed: 0 }, pendingCount: 1, reviewCount: 0, lastSyncedAt: rows[0].lastSyncedAt }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    await waitFor(() => {
      expect(screen.getByText("Chase Checking")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Pending 1")).toBeInTheDocument();
    });

    // Verify sync call went to token endpoint
    const syncCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/sync/tokens/5/sync")
    );
    expect(syncCall).toBeDefined();
  });
});
