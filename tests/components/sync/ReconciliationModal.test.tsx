import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciliationModal } from "@/components/sync/ReconciliationModal";
import { KeyboardShortcutProvider } from "@/components/KeyboardShortcutProvider";
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
  plaidAccountMask: null,
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

// Stubs global.fetch for the reconciliation queue GET and, optionally, the
// resolve-action POST. One fixture, shared by every test in this file —
// tests that only read the rendered queue omit onPost; tests that click a
// button or fire a keyboard shortcut pass one to see what got sent.
function stubQueueList(
  items: SyncReconciliationItem[],
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
          items,
          totalCount: items.length,
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

// A single-item queue is the common case — thin wrapper over stubQueueList.
function stubQueueFetch(
  item: SyncReconciliationItem,
  onPost?: (body: unknown) => Promise<Response> | Response
) {
  return stubQueueList([item], onPost);
}

/** POST bodies sent to the reconcile route, in order. */
function reconcilePosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes("/sync/accounts/") &&
        String(url).includes("/reconcile") &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
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
      plaidAccountMask: null,
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

    // The sole candidate is promoted into the decision block, where the
    // explanation lives in the button's title tooltip rather than a
    // separate paragraph (that paragraph is still used for candidates
    // folded into the "other candidates" disclosure).
    const matchButton = await screen.findByRole("button", { name: "Match" });
    expect(matchButton).toBeDisabled();
    expect(matchButton).toHaveAttribute(
      "title",
      "Already matched to another synced transaction"
    );
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
    // The decision block carries its own Match & Update branch when
    // candidates[0] has the delta (see the dedicated regression test below);
    // this test instead exercises the same branch on a folded candidate, in
    // the "other candidates" disclosure, by putting the delta second.
    const item = makeItem({
      candidates: [
        makeCandidate({ transactionId: 6, alreadyLinked: false }),
        makeCandidate({
          transactionId: 7,
          alreadyLinked: false,
          amountDelta: 100,
          splitCount: 2,
        }),
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

    fireEvent.click(await screen.findByRole("button", { name: /1 other candidate/i }));

    const updateButton = await screen.findByRole("button", { name: /^Match & Update/ });
    fireEvent.click(updateButton);

    // The clicked button shows the in-flight label; the plain Match buttons do not.
    expect(
      await screen.findByRole("button", { name: "Matching…" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Match" }).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /^Match & Update/ })
    ).not.toBeInTheDocument();

    resolvePost?.();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Matching…" })).not.toBeInTheDocument();
    });
  });

  it("reaches Match & Update directly when the best candidate itself carries the delta", async () => {
    // Regression: candidates[0] is the ONLY candidate and has a non-zero
    // amountDelta with splitCount 2. otherCandidates is empty, so the "other
    // candidates" disclosure never renders -- if the decision block did not
    // carry its own Match & Update branch, this action would be entirely
    // unreachable, not just buried a click deeper. A plain `match` here
    // would reconcile the transaction without correcting its amount to the
    // bank's figure (see lib/plaid-reconcile.ts), which is a correctness bug
    // in a double-entry ledger.
    const item = makeItem({
      candidates: [
        makeCandidate({ transactionId: 42, amountDelta: 250, splitCount: 2 }),
      ],
    });

    const postSpy = vi.fn();
    stubQueueFetch(item, (body) => {
      postSpy(body);
      return {
        ok: true,
        json: async () => ({
          ...item,
          resolutionStatus: "matched",
          matchedTransactionId: 42,
        }),
      } as Response;
    });

    render(<ReconciliationModal isOpen row={baseRow} onClose={vi.fn()} />);

    // No disclosure to open first -- the only candidate is the decision
    // block itself.
    const best = await screen.findByTestId("best-match");
    expect(within(best).getByRole("button", { name: "Match" })).toBeInTheDocument();
    const updateButton = within(best).getByRole("button", { name: /^Match & Update/ });
    expect(updateButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /other candidate/i })).toBeNull();

    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledTimes(1);
    });
    expect(postSpy.mock.calls[0][0]).toMatchObject({
      action: "match_update_amount",
      transactionId: 42,
    });
  });

  describe("queue semantics: tags, reason lines, and signed amounts", () => {
    const row = baseRow;

    // Item 1: an easy row — its top candidate carries the tags for an exact
    // match. Item 2: no candidates at all. Item 4: flagged by the bank, which
    // must win over whatever its candidates say.
    const items: SyncReconciliationItem[] = [
      makeItem({
        id: 1,
        amountCents: 4250,
        candidates: [
          makeCandidate({
            transactionId: 501,
            scoreTags: ["exact_amount", "same_day", "name_exact"],
          }),
        ],
      }),
      makeItem({ id: 2, amountCents: 500, candidates: [] }),
      makeItem({
        id: 4,
        amountCents: 900,
        reviewReason: "plaid_modified",
        candidates: [],
      }),
    ];

    beforeEach(() => {
      stubQueueList(items);
    });

    it("shows the reason a queue row is here, and reserves amber for bank changes", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      const exact = await screen.findByTestId("queue-item-1");
      expect(exact).toHaveTextContent("exact match found");
      expect(exact.querySelector(".text-fg-warning")).toBeNull();

      const modified = screen.getByTestId("queue-item-4");
      expect(modified).toHaveTextContent("changed at the bank");
      expect(modified.querySelector(".text-fg-warning")).not.toBeNull();
    });

    it("shows a queue row with no candidates as having no match", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      expect(await screen.findByTestId("queue-item-2")).toHaveTextContent("no match");
    });

    it("negates the Plaid amount so the queue shows what the ledger will record", async () => {
      // reconciliation item amountCents: 4250 (Plaid signs a charge positive)
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      // formatCurrency renders a true Unicode minus (U+2212), not an ASCII
      // hyphen — see lib/formatters.ts — so the expectation below uses it too.
      expect(await screen.findByTestId("queue-item-1")).toHaveTextContent("−$42.50");
    });

    it("labels the best match from the tags the server sent, not from a delta", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      const best = await screen.findByTestId("best-match");
      expect(best).toHaveTextContent("exact amount");
      expect(best).toHaveTextContent("same day");
      expect(best).toHaveTextContent("same payee");
      expect(best).not.toHaveTextContent("delta $0.00");
    });
  });

  describe("decision block, disclosures, and pinned footer", () => {
    const row = baseRow;

    // Item 21: three candidates, so the top one is promoted and two fold
    // away. Item 22: no candidates at all, so Create must open on its own.
    // Item 23: flagged by the bank, so Keep local and Unlink must enable.
    const items: SyncReconciliationItem[] = [
      makeItem({
        id: 21,
        amountCents: 4250,
        candidates: [
          makeCandidate({
            transactionId: 601,
            payeeName: "Blue Bottle",
            scoreTags: ["exact_amount", "same_day"],
          }),
          makeCandidate({
            transactionId: 602,
            payeeName: null,
            description: "Grocery run",
            dayDelta: 2,
            amountDelta: 300,
          }),
          makeCandidate({
            transactionId: 603,
            payeeName: null,
            description: "Gas station",
            dayDelta: 5,
            amountDelta: 700,
          }),
        ],
      }),
      makeItem({ id: 22, amountCents: 500, candidates: [] }),
      makeItem({
        id: 23,
        amountCents: 900,
        reviewReason: "plaid_modified",
        candidates: [],
      }),
    ];

    beforeEach(() => {
      stubQueueList(items);
    });

    it("promotes the top candidate out of the list into one decision", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      const best = await screen.findByTestId("best-match");
      expect(within(best).getByRole("button", { name: /^Match/ })).toBeInTheDocument();

      // the rest are folded away
      expect(screen.queryByText("Grocery run")).toBeNull();
      expect(screen.getByRole("button", { name: /2 other candidates/i })).toBeInTheDocument();
    });

    it("opens Create by default when there is nothing to match against", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      fireEvent.click(await screen.findByTestId("queue-item-22"));
      expect(await screen.findByLabelText(/Counter account/i)).toBeInTheDocument();
    });

    it("keeps the escape hatches in a footer, disabled when they do not apply", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      const footer = await screen.findByTestId("resolve-footer");

      expect(within(footer).getByRole("button", { name: /Ignore/ })).toBeEnabled();
      expect(within(footer).getByRole("button", { name: /Keep local/ })).toBeDisabled();
      expect(within(footer).getByRole("button", { name: /Unlink/ })).toBeDisabled();
      expect(footer).toHaveTextContent(/rows the bank changed/i);
    });

    it("enables Keep local and Unlink on a row the bank changed", async () => {
      render(<ReconciliationModal isOpen row={row} onClose={vi.fn()} />);
      fireEvent.click(await screen.findByTestId("queue-item-23"));

      const footer = screen.getByTestId("resolve-footer");
      expect(within(footer).getByRole("button", { name: /Keep local/ })).toBeEnabled();
      expect(within(footer).getByRole("button", { name: /Unlink/ })).toBeEnabled();
    });
  });

  // The reload used to be fired from inside a setItems updater. Updaters must
  // be pure — React re-invokes them under StrictMode and may replay them while
  // rendering concurrently — so the reload has to happen after the state is
  // written, exactly once.
  it("reloads the queue once when resolving empties a page that has more", async () => {
    const first = makeItem({ id: 1, candidates: [] });
    const second = makeItem({ id: 2, candidates: [] });
    let queueGets = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/b/1/accounts?includeInactive=true") {
        return { ok: true, json: async () => [] } as Response;
      }

      if (
        url.startsWith("/api/b/1/sync/accounts/11/reconcile?") &&
        (!init || init.method === "GET")
      ) {
        queueGets += 1;
        const firstPage = queueGets === 1;
        return {
          ok: true,
          json: async () => ({
            items: firstPage ? [first] : [second],
            totalCount: 2,
            offset: 0,
            limit: 25,
            hasMore: firstPage,
          }),
        } as Response;
      }

      if (url === "/api/b/1/sync/accounts/11/reconcile" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ ...first, resolutionStatus: "ignored" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ReconciliationModal isOpen row={baseRow} onClose={vi.fn()} />);
    await screen.findByTestId("queue-item-1");
    expect(queueGets).toBe(1);

    fireEvent.click(
      within(screen.getByTestId("resolve-footer")).getByRole("button", { name: "Ignore" })
    );

    await screen.findByTestId("queue-item-2");
    expect(queueGets).toBe(2);
  });

  describe("keyboard flow", () => {
    const row = baseRow;

    // The queue's own KeyboardShortcutProvider mock elsewhere in the suite
    // (see tests/app/transactions/page.test.tsx) is a no-op stub; these tests
    // need the real provider so a fired keydown actually reaches the modal's
    // registered shortcuts, the same way it does in the running app.
    function renderModal() {
      return render(
        <KeyboardShortcutProvider>
          <ReconciliationModal isOpen row={row} onClose={vi.fn()} />
        </KeyboardShortcutProvider>
      );
    }

    it("moves through the queue with the arrow keys", async () => {
      const items = [
        makeItem({ id: 1, candidates: [makeCandidate({ transactionId: 101 })] }),
        makeItem({ id: 2, candidates: [] }),
      ];
      stubQueueList(items);

      renderModal();
      await screen.findByTestId("queue-item-1");
      expect(screen.getByTestId("queue-item-1")).toHaveAttribute("aria-current", "true");

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(screen.getByTestId("queue-item-2")).toHaveAttribute("aria-current", "true");

      fireEvent.keyDown(document, { key: "ArrowUp" });
      expect(screen.getByTestId("queue-item-1")).toHaveAttribute("aria-current", "true");
    });

    it("resolves the best match on Enter through the same path as the Match button", async () => {
      const item = makeItem({
        id: 1,
        candidates: [makeCandidate({ transactionId: 101 })],
      });
      const fetchMock = stubQueueList(
        [item],
        () =>
          ({
            ok: true,
            json: async () => ({
              ...item,
              resolutionStatus: "matched",
              matchedTransactionId: 101,
            }),
          }) as Response
      );

      renderModal();
      await screen.findByTestId("best-match");

      fireEvent.keyDown(document, { key: "Enter" });

      await waitFor(() => expect(reconcilePosts(fetchMock)).toHaveLength(1));
      expect(reconcilePosts(fetchMock)[0]).toMatchObject({
        action: "match",
        transactionId: 101,
      });
    });

    it("does nothing on Enter when the selected row has no candidates", async () => {
      const items = [
        makeItem({ id: 1, candidates: [] }),
        makeItem({ id: 2, candidates: [] }),
      ];
      const fetchMock = stubQueueList(items);

      renderModal();
      await screen.findByTestId("queue-item-2");

      fireEvent.keyDown(document, { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("queue-item-2")).toBeInTheDocument());
      expect(reconcilePosts(fetchMock)).toHaveLength(0);
    });

    it("leaves Enter to the focused button instead of matching the best candidate", async () => {
      const item = makeItem({
        id: 1,
        candidates: [makeCandidate({ transactionId: 101 })],
      });
      const fetchMock = stubQueueList(
        [item],
        () =>
          ({
            ok: true,
            json: async () => ({ ...item, resolutionStatus: "ignored" }),
          }) as Response
      );

      renderModal();
      await screen.findByTestId("best-match");

      // A keyboard user tabs to Ignore. Enter must activate Ignore, not the
      // Enter shortcut — matching a transaction nobody chose is a
      // data-correctness bug, not a stray keystroke.
      const ignore = within(screen.getByTestId("resolve-footer")).getByRole("button", {
        name: "Ignore",
      });
      ignore.focus();
      fireEvent.keyDown(ignore, { key: "Enter" });

      expect(reconcilePosts(fetchMock)).toHaveLength(0);

      // …and the button still works: its own activation is untouched.
      fireEvent.click(ignore);
      await waitFor(() => expect(reconcilePosts(fetchMock)).toHaveLength(1));
      expect(reconcilePosts(fetchMock)[0]).toMatchObject({ action: "ignore" });
    });

    it("ignores with I, and K does nothing on a row the bank did not change", async () => {
      const item = makeItem({
        id: 1,
        candidates: [makeCandidate({ transactionId: 101 })],
      });
      const fetchMock = stubQueueList(
        [item],
        () =>
          ({
            ok: true,
            json: async () => ({ ...item, resolutionStatus: "ignored" }),
          }) as Response
      );

      renderModal();
      await screen.findByTestId("best-match");

      // K resolves keep_local, which the pinned footer only enables for a row
      // the bank flagged (reviewReason != null) -- this item has none, so K
      // must mirror the footer's disabled state and do nothing.
      fireEvent.keyDown(document, { key: "k" });
      expect(reconcilePosts(fetchMock)).toHaveLength(0);

      fireEvent.keyDown(document, { key: "i" });
      await waitFor(() => expect(reconcilePosts(fetchMock)).toHaveLength(1));
      expect(reconcilePosts(fetchMock)[0]).toMatchObject({ action: "ignore" });
    });
  });
});
