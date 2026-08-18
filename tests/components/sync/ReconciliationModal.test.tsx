import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconciliationModal } from "@/components/sync/ReconciliationModal";
import type {
  AssignedSyncAccount,
  SyncMatchCandidate,
  SyncReconciliationItem,
} from "@/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ bookId: "1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/b/1/sync",
}));

const baseRow: AssignedSyncAccount = {
  plaidLinkId: 11,
  financialInstitution: "Chase",
  tokenId: 5,
  itemId: "item-1",
  plaidAccountId: "plaid-checking",
  plaidAccountName: "Chase Checking",
  counterpoiseAccountId: 1,
  counterpoiseAccountName: "Checking",
  lastSyncedAt: null,
  lastError: null,
  pendingCount: 1,
  reviewCount: 0,
};

function makeCandidate(
  overrides: Partial<SyncMatchCandidate> = {}
): SyncMatchCandidate {
  return {
    transactionId: 7,
    date: "2026-02-09",
    description: "Coffee",
    payeeName: "Blue Bottle",
    checkNumber: null,
    linkedSplitAmount: -1234,
    expectedAmount: -1234,
    amountDelta: 0,
    dayDelta: 0,
    counterpartAccountNames: ["Groceries"],
    splitCount: 2,
    score: 10,
    scoreTags: [],
    alreadyLinked: false,
    ...overrides,
  };
}

function makeItem(
  overrides: Partial<SyncReconciliationItem> = {}
): SyncReconciliationItem {
  return {
    id: 99,
    plaidAccountLinkId: 11,
    plaidTransactionId: "plaid-txn-1",
    date: "2026-02-09",
    authorizedDate: null,
    amountCents: 1234,
    name: "BLUE BOTTLE",
    merchantName: "Blue Bottle",
    originalDescription: "BLUE BOTTLE CAFE",
    resolutionStatus: "pending",
    reviewReason: null,
    matchedTransactionId: null,
    pending: false,
    firstSeenAt: "2026-02-09T00:00:00.000Z",
    lastSeenAt: "2026-02-09T00:00:00.000Z",
    candidates: [],
    suggestedCounterAccountId: 2,
  ...overrides,
  };
}

function stubQueueFetch(
  item: SyncReconciliationItem,
  onPost?: (body: unknown) => Promise<Response> | Response
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/b/1/accounts?includeInactive=true") {
      return { ok: true, json: async () => [] } as Response;
    }

    if (
      url === "/api/b/1/sync/accounts/11/reconcile?limit=25&offset=0" &&
      (!init || init.method === "GET")
    ) {
      return {
        ok: true,
        json: async () => ({
          items: [item],
          totalCount: 1,
          offset: 0,
          limit: 25,
          hasMore: false,
        }),
      } as Response;
    }

    if (url === "/api/b/1/sync/accounts/11/reconcile" && init?.method === "POST" && onPost) {
      return onPost(JSON.parse((init.body as string) || "{}"));
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ReconciliationModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults payee from plaid transaction and sends edited payee in create action", async () => {
    const row: AssignedSyncAccount = {
      plaidLinkId: 11,
      financialInstitution: "Chase",
      tokenId: 5,
      itemId: "item-1",
      plaidAccountId: "plaid-checking",
      plaidAccountName: "Chase Checking",
      counterpoiseAccountId: 1,
      counterpoiseAccountName: "Checking",
      lastSyncedAt: null,
      lastError: null,
      pendingCount: 1,
      reviewCount: 0,
    };

    const item: SyncReconciliationItem = {
      id: 99,
      plaidAccountLinkId: 11,
      plaidTransactionId: "plaid-txn-1",
      date: "2026-02-09",
      authorizedDate: null,
      amountCents: 1234,
      name: "BLUE BOTTLE",
      merchantName: "Blue Bottle",
      originalDescription: "BLUE BOTTLE CAFE",
      resolutionStatus: "pending",
      reviewReason: null,
      matchedTransactionId: null,
      pending: false,
      firstSeenAt: "2026-02-09T00:00:00.000Z",
      lastSeenAt: "2026-02-09T00:00:00.000Z",
      candidates: [],
      suggestedCounterAccountId: 2,
    };

    const postSpy = vi.fn();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/accounts?includeInactive=true") {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              name: "Checking",
              type: "asset",
              subtype: "bank",
              parentId: null,
              isActive: true,
              isFavorite: false,
              isInvestmentCash: false,
              icon: null,
              balance: 0,
              hasTransactions: false,
              children: [],
            },
            {
              id: 2,
              name: "Groceries",
              type: "expense",
              subtype: null,
              parentId: null,
              isActive: true,
              isFavorite: false,
              isInvestmentCash: false,
              icon: null,
              balance: 0,
              hasTransactions: false,
              children: [],
            },
          ],
        } as Response;
      }

      if (
        url === "/api/b/1/sync/accounts/11/reconcile?limit=25&offset=0" &&
        (!init || init.method === "GET")
      ) {
        return {
          ok: true,
          json: async () => ({
            items: [item],
            totalCount: 1,
            offset: 0,
            limit: 25,
            hasMore: false,
          }),
        } as Response;
      }

      if (url === "/api/b/1/sync/accounts/11/reconcile" && init?.method === "POST") {
        postSpy(JSON.parse((init.body as string) || "{}"));
        return {
          ok: true,
          json: async () => ({
            ...item,
            resolutionStatus: "created",
            matchedTransactionId: 100,
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReconciliationModal
        isOpen
        row={row}
        onClose={vi.fn()}
      />
    );

    const payeeInput = await screen.findByLabelText("Payee");
    await waitFor(() => {
      expect(payeeInput).toHaveValue("Blue Bottle");
    });

    fireEvent.change(payeeInput, { target: { value: "Coffee Shop" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledTimes(1);
    });

    expect(postSpy.mock.calls[0][0]).toMatchObject({
      action: "create",
      reconciliationId: 99,
      counterAccountId: 2,
      payeeName: "Coffee Shop",
    });
  });

  it("explains why Match is disabled for an already-linked candidate", async () => {
    const item = makeItem({
      candidates: [makeCandidate({ alreadyLinked: true })],
    });
    stubQueueFetch(item);

    render(<ReconciliationModal isOpen row={baseRow} onClose={vi.fn()} />);

    const matchButton = await screen.findByRole("button", { name: "Match" });
    expect(matchButton).toBeDisabled();
    expect(
      screen.getByText("Already matched to another synced transaction")
    ).toBeInTheDocument();
  });

  it("shows in-flight feedback on the Match button while submitting", async () => {
    const item = makeItem({
      candidates: [makeCandidate({ alreadyLinked: false })],
    });

    let resolvePost: (() => void) | undefined;
    stubQueueFetch(item, () => {
      return new Promise<Response>((resolve) => {
        resolvePost = () =>
          resolve({
            ok: true,
            json: async () => ({
              ...item,
              resolutionStatus: "matched",
              matchedTransactionId: 7,
            }),
          } as Response);
      });
    });

    render(<ReconciliationModal isOpen row={baseRow} onClose={vi.fn()} />);

    const matchButton = await screen.findByRole("button", { name: "Match" });
    fireEvent.click(matchButton);

    expect(
      await screen.findByRole("button", { name: "Matching…" })
    ).toBeInTheDocument();

    resolvePost?.();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Matching…" })).not.toBeInTheDocument();
    });
  });

  it("shows in-flight feedback on the Match & Update button that was clicked", async () => {
    const item = makeItem({
      candidates: [
        makeCandidate({ alreadyLinked: false, amountDelta: 100, splitCount: 2 }),
      ],
    });

    let resolvePost: (() => void) | undefined;
    stubQueueFetch(item, () => {
      return new Promise<Response>((resolve) => {
        resolvePost = () =>
          resolve({
            ok: true,
            json: async () => ({
              ...item,
              resolutionStatus: "matched",
              matchedTransactionId: 7,
            }),
          } as Response);
      });
    });

    render(<ReconciliationModal isOpen row={baseRow} onClose={vi.fn()} />);

    const updateButton = await screen.findByRole("button", { name: /^Match & Update/ });
    fireEvent.click(updateButton);

    // The clicked button shows the in-flight label; the plain Match button does not.
    expect(
      await screen.findByRole("button", { name: "Matching…" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Match" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Match & Update/ })
    ).not.toBeInTheDocument();

    resolvePost?.();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Matching…" })).not.toBeInTheDocument();
    });
  });
});
