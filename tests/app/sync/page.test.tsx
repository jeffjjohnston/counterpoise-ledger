import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SyncPage from "@/app/b/[bookId]/sync/page";
import { SYNC_QUEUE_CHANGED_EVENT } from "@/lib/events";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn() }),
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

  it("renders grouped assigned accounts with header sync controls", async () => {
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

    // The old bare "Manage Tokens" link is gone — the header now offers a
    // "Sync all" action plus a menu holding the (renamed) navigation item.
    expect(screen.queryByText("Manage Tokens")).toBeNull();
    expect(screen.getByRole("button", { name: "Sync all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync options" })).toBeInTheDocument();
    expect(screen.getByText("Chase")).toBeInTheDocument();
    expect(screen.getByText("Chase Checking")).toBeInTheDocument();
    expect(screen.getByText("Chase Savings")).toBeInTheDocument();
    expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
    expect(screen.getByText("2 waiting")).toBeInTheDocument();
    expect(screen.getByText(/1 changed at the bank/)).toBeInTheDocument();
  });

  it("renders mappings as rows rather than a table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Sapphire",
              plaidAccountMask: "4567",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Credit Card",
              lastSyncedAt: null,
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
    await screen.findByText("Chase Bank");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Plaid Account")).toBeNull();
    expect(screen.queryByText("Counterpoise Account")).toBeNull();
  });

  it("shows both sides of the mapping with the bank mask", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Sapphire",
              plaidAccountMask: "4567",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Credit Card",
              lastSyncedAt: null,
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
    const mapping = await screen.findByTestId("mapping-11");
    expect(mapping).toHaveTextContent("Chase Sapphire");
    expect(mapping).toHaveTextContent("4567");
    expect(within(mapping).getByRole("img", { name: /maps to/i })).toBeInTheDocument();
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

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/ITEM_LOGIN_REQUIRED/)).toBeInTheDocument();
    // The per-card duplicate is gone — the failure is reported once, in the banner.
    expect(screen.queryByText(/Last sync failed:/i)).toBeNull();
  });

  it("renders an empty state when there are no mappings", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    await waitFor(() => {
      expect(screen.getByText("No bank accounts are connected yet")).toBeInTheDocument();
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
      expect(screen.getByText("1 waiting")).toBeInTheDocument();
    });

    // Verify sync call went to token endpoint
    const syncCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/sync/tokens/5/sync")
    );
    expect(syncCall).toBeDefined();
  });

  it("does not offer Review on a mapping with an empty queue", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Sapphire",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Sapphire Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: null,
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
    await screen.findByText("Chase Sapphire");
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
  });

  it("offers Review with its count when the queue is not empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Ally Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Ally Savings",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Savings",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 5,
              reviewCount: 0,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    const reviewButton = await screen.findByRole("button", { name: "Review 5" });
    expect(reviewButton).toBeInTheDocument();
    // Pins the >=44px touch target (min-h-11 = 2.75rem): the primary action
    // on a page whose whole point is to work on a phone must stay reachable.
    expect(reviewButton).toHaveClass("min-h-11");
  });

  it("keeps Reset out of the card header and behind a confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: null,
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
    await screen.findByText("Chase Bank");

    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Chase Bank actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Reset sync data/i }));

    // The confirmation is up, and nothing has been sent yet — opening the menu
    // item must not itself be the destructive act.
    expect(
      await screen.findByText(/staged transaction.*will be discarded/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Reset sync data/ })
    ).toBeInTheDocument();
  });

  it("shows one error surface naming the connection, with a retry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Citi",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Citi Checking",
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

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Citi");
    expect(within(banner).getByRole("button", { name: /Retry/i })).toBeInTheDocument();

    // the per-card duplicate is gone
    expect(screen.queryByText(/Last sync failed:/i)).toBeNull();
  });

  it("gives each connection a dot that says what its own signal means", async () => {
    const recently = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const longAgo = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Citi",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Citi Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: recently,
              lastError: "ITEM_LOGIN_REQUIRED",
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 12,
              financialInstitution: "Ally",
              tokenId: 6,
              itemId: "item-2",
              plaidAccountId: "plaid-2",
              plaidAccountName: "Ally Savings",
              counterpoiseAccountId: 2,
              counterpoiseAccountName: "Savings",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 13,
              financialInstitution: "Chase",
              tokenId: 7,
              itemId: "item-3",
              plaidAccountId: "plaid-3",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 3,
              counterpoiseAccountName: "Chase",
              lastSyncedAt: longAgo,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 14,
              financialInstitution: "Amex",
              tokenId: 8,
              itemId: "item-4",
              plaidAccountId: "plaid-4",
              plaidAccountName: "Amex Card",
              counterpoiseAccountId: 4,
              counterpoiseAccountName: "Amex",
              lastSyncedAt: recently,
              lastError: null,
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
    await screen.findByText("Citi");

    // Each label names sync freshness, never mapping completeness — that is
    // the connections page's dot, and the two must not read as one signal.
    const failed = screen.getByLabelText("Citi: last sync failed");
    expect(failed.className).toContain("bg-[var(--fg-danger)]");

    const never = screen.getByLabelText("Ally: never synced");
    expect(never.className).toContain("bg-[var(--fg-warning)]");

    const stale = screen.getByLabelText("Chase: last synced more than 24 hours ago");
    expect(stale.className).toContain("bg-[var(--fg-warning)]");

    const fresh = screen.getByLabelText("Amex: synced within the last 24 hours");
    expect(fresh.className).toContain("bg-[var(--fg-success)]");
  });

  it("keeps one error surface when a retry fails on an already-failing connection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Citi",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Citi Checking",
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

      if (url === "/api/b/1/sync/tokens/5/sync" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "still logged out" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    const banner = await screen.findByRole("alert");
    fireEvent.click(within(banner).getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("still logged out");
    });

    // The recorded failure and the one the retry just produced are the same
    // news; two stacked red banners said it twice.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Citi could not sync");
  });

  it("names the connection that just failed, not one with an older stored failure", async () => {
    // Citi carries a lastError from some earlier sync. Chase is clean until the
    // user syncs it and that call fails. syncOne only refetches on success, so
    // failedConnections still describes the pre-click state -- the banner has to
    // take its identity from the failure the user just triggered, or it names
    // Citi, shows Chase's message underneath it, and points Retry at Citi.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Citi",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Citi Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: "ITEM_LOGIN_REQUIRED",
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 12,
              financialInstitution: "Chase Bank",
              tokenId: 6,
              itemId: "item-2",
              plaidAccountId: "plaid-2",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 2,
              counterpoiseAccountName: "Chase",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
          ],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/6/sync" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    const chaseCard = (await screen.findByRole("heading", { name: "Chase Bank" })).closest(
      "section"
    ) as HTMLElement;
    fireEvent.click(within(chaseCard).getByRole("button", { name: "Sync" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("RATE_LIMIT_EXCEEDED");
    });

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Chase Bank could not sync");
    // Citi is still failing, so it is counted -- but it does not get to be the
    // connection the banner is about.
    expect(banner).toHaveTextContent("along with 1 other connection");
    expect(banner).not.toHaveTextContent("Citi could not sync");

    // And Retry has to reach the connection the banner just named.
    fetchMock.mockClear();
    fireEvent.click(within(banner).getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/b/1/sync/tokens/6/sync",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("does not offer Sync all before anything is connected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return { ok: true, json: async () => [] } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    await screen.findByText("No bank accounts are connected yet");

    expect(screen.getByRole("button", { name: "Sync all" })).toBeDisabled();
  });

  it("does not start the review-only count with a dangling separator", async () => {
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
              lastError: null,
              pendingCount: 0,
              reviewCount: 2,
            },
          ],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);

    const mapping = await screen.findByTestId("mapping-11");
    expect(mapping).toHaveTextContent("2 changed at the bank");
    expect(mapping.textContent).not.toContain("· 2 changed at the bank");
  });

  it("summarises connections, queue total and freshest sync above the list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: "2026-02-09T10:30:00.000Z",
              pendingCount: 3,
              reviewCount: 2,
            },
            {
              plaidLinkId: 12,
              financialInstitution: "Ally Bank",
              tokenId: 6,
              itemId: "item-2",
              plaidAccountId: "plaid-2",
              plaidAccountName: "Ally Savings",
              counterpoiseAccountId: 2,
              counterpoiseAccountName: "Savings",
              lastSyncedAt: null,
              pendingCount: 1,
              reviewCount: 2,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    const summary = await screen.findByTestId("sync-summary");
    expect(summary).toHaveTextContent("2 connections");
    expect(summary).toHaveTextContent("8 to review");
  });

  it("re-fetches when the sync queue changes elsewhere", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
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
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    await screen.findByText("Chase Bank");
    const before = fetchMock.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SYNC_QUEUE_CHANGED_EVENT));
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("offers a route into setup when nothing is mapped", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    expect(await screen.findByText(/No bank accounts are connected yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect a bank/i })).toHaveAttribute(
      "href",
      "/b/1/sync/tokens"
    );
  });

  it("reports every failing connection when Sync all fails on more than one, not just the last", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Chase Bank",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Chase Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
            {
              plaidLinkId: 12,
              financialInstitution: "Ally Bank",
              tokenId: 6,
              itemId: "item-2",
              plaidAccountId: "plaid-2",
              plaidAccountName: "Ally Savings",
              counterpoiseAccountId: 2,
              counterpoiseAccountName: "Savings",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
          ],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/5/sync" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "ITEM_LOGIN_REQUIRED" }),
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/6/sync" && init?.method === "POST") {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: "RATE_LIMIT_EXCEEDED" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    await screen.findByText("Chase Bank");
    await screen.findByText("Ally Bank");

    fireEvent.click(screen.getByRole("button", { name: "Sync all" }));

    const banner = await screen.findByRole("alert");
    // Both failures must be named -- a naive loop over handleSync would leave
    // only Ally Bank's (the last one attempted) on screen.
    expect(banner).toHaveTextContent("2 connections failed to sync");
    expect(banner).toHaveTextContent("Chase Bank: ITEM_LOGIN_REQUIRED");
    expect(banner).toHaveTextContent("Ally Bank: RATE_LIMIT_EXCEEDED");

    // Every token's syncing flag clears once the loop finishes, even though
    // the first connection in it failed -- the button is enabled again and
    // its label is back to the idle "Sync all", not stuck on "Syncing…".
    const syncAllButton = screen.getByRole("button", { name: "Sync all" });
    expect(syncAllButton).toHaveTextContent("Sync all");
    expect(syncAllButton).not.toBeDisabled();
  });

  it("renders the bare 'institution: message' form when Sync all fails on exactly one connection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/b/1/sync/assigned-accounts") {
        return {
          ok: true,
          json: async () => [
            {
              plaidLinkId: 11,
              financialInstitution: "Citi",
              tokenId: 5,
              itemId: "item-1",
              plaidAccountId: "plaid-1",
              plaidAccountName: "Citi Checking",
              counterpoiseAccountId: 1,
              counterpoiseAccountName: "Checking",
              lastSyncedAt: null,
              lastError: null,
              pendingCount: 0,
              reviewCount: 0,
            },
          ],
        } as Response;
      }

      if (url === "/api/b/1/sync/tokens/5/sync" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "ITEM_LOGIN_REQUIRED" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<SyncPage />);
    await screen.findByText("Citi");

    fireEvent.click(screen.getByRole("button", { name: "Sync all" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Citi: ITEM_LOGIN_REQUIRED");
    // The plural rollup phrasing belongs to the failures.length > 1 branch only.
    expect(banner).not.toHaveTextContent(/connections failed to sync/);
  });
});
