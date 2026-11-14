// tests/app/search-page.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import SearchPage from "@/app/b/[bookId]/search/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/search",
    useSearchParams: () => new URLSearchParams(),
  })
);

// The search page starts a search 300 ms after the last change to the query.
// This value comes from app/b/[bookId]/search/page.tsx. If the page changes
// it, change it here.
const DEBOUNCE_MS = 300;

/** Type a query, then move the fake clock to the end of the debounce. */
async function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/Search transactions/), {
    target: { value },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); });
}

describe("SearchPage", () => {
  afterEach(() => { vi.useRealTimers(); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );
  });

  it("renders the search page with title and input", () => {
    render(<SearchPage />);
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search transactions/)
    ).toBeInTheDocument();
  });

  it("shows no results message after search with debounce", async () => {
    render(<SearchPage />);
    await search("nonexistent");

    expect(screen.getByText(/No results found/)).toBeInTheDocument();
  });

  it("displays transactions when results are returned", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [
            {
              id: 1,
              date: "2024-01-15",
              description: "Coffee Shop",
              checkNumber: null,
              payee: { id: 10, name: "Starbucks" },
              splits: [
                {
                  accountId: 1,
                  accountName: "Checking",
                  amount: 500,
                  isFavorite: true,
                  subtype: "bank",
                  isInvestmentCash: false,
                  icon: null,
                },
              ],
            },
          ],
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );

    render(<SearchPage />);
    await search("starbucks");

    expect(screen.getByText("Starbucks")).toBeInTheDocument();
  });

  // 2026-08-15 is a Saturday. A businessDaysOnly rule is observed on Monday
  // 2026-08-17, and search must agree with the recurring page about that.
  it("shows the observed next date for a business-day-only rule", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: {
            items: [
              {
                id: 7,
                name: "Vacation Fund Transfer",
                frequency: "monthly",
                nextDate: "2026-08-15",
                businessDaysOnly: true,
                isActive: true,
              },
            ],
            total: 1,
            truncated: false,
          },
        })
      )
    );

    render(<SearchPage />);
    await search("vacation");

    expect(screen.getByText("Vacation Fund Transfer")).toBeInTheDocument();
    expect(screen.getByText("Aug 17, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Aug 15, 2026")).not.toBeInTheDocument();
  });

  it("shows the scheduled next date when the rule is not business-day only", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: { items: [], total: 0, truncated: false },
          recurringRules: {
            items: [
              {
                id: 8,
                name: "Vacation Fund Transfer",
                frequency: "monthly",
                nextDate: "2026-08-15",
                businessDaysOnly: false,
                isActive: true,
              },
            ],
            total: 1,
            truncated: false,
          },
        })
      )
    );

    render(<SearchPage />);
    await search("vacation");

    expect(screen.getByText("Vacation Fund Transfer")).toBeInTheDocument();
    expect(screen.getByText("Aug 15, 2026")).toBeInTheDocument();
  });

  // Decision 2 exists so a reader can see the 25-row cut. A heading that still
  // reads "Payees (25)" when 112 matched hides exactly what the total and
  // truncated fields were added to expose, so assert the rendered text, not
  // just that the fields arrived.
  it("reports the true total in a bucket heading when the LIMIT truncated it", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: {
            items: [
              { id: 1, name: "Zebra Supply" },
              { id: 2, name: "Zebra Foods" },
            ],
            total: 112,
            truncated: true,
          },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );

    render(<SearchPage />);
    await search("zebra");

    expect(screen.getByText("Payees (2 of 112)")).toBeInTheDocument();
    expect(screen.queryByText("Payees (2)")).not.toBeInTheDocument();
  });

  it("omits the total from a bucket heading when nothing was truncated", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          accounts: { items: [], total: 0, truncated: false },
          payees: {
            items: [
              { id: 1, name: "Zebra Supply" },
              { id: 2, name: "Zebra Foods" },
            ],
            total: 2,
            truncated: false,
          },
          recurringRules: { items: [], total: 0, truncated: false },
        })
      )
    );

    render(<SearchPage />);
    await search("zebra");

    expect(screen.getByText("Payees (2)")).toBeInTheDocument();
  });

  it("does not call fetch when query is empty", async () => {
    render(<SearchPage />);
    // No input change. Let the debounce window pass: fetch must not be called.
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });
});

// Another client (an MCP tool, a second tab, a scheduled job) changes the
// book. The server sends the book socket a hint for each changed table, and
// the page must run the search again without a reload.
describe("SearchPage live updates", () => {
  const emptyBucket = { items: [], total: 0, truncated: false };
  const payee = (id: number, name: string) => ({ id, name });
  let payees: Array<{ id: number; name: string }> = [];
  // When set, each search waits for the test to release it.
  let hold: Array<() => void> | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  function socket() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  function hint(tables: string[]) {
    act(() => { socket().emit("change", { tables }); });
  }

  function searches() {
    return fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/b/1/search"));
  }

  // The provider sends hints after 100 ms. Wait longer than that before a
  // test says that no search occurred.
  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  }

  beforeEach(() => {
    payees = [payee(10, "Starbucks")];
    hold = null;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    fetchMock = vi.fn(async () => {
      const answer = {
        transactions: [],
        accounts: emptyBucket,
        payees: { items: payees, total: payees.length, truncated: false },
        recurringRules: emptyBucket,
      };
      if (hold) await new Promise<void>((release) => { hold!.push(release); });
      return new Response(JSON.stringify(answer));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  function renderLive() {
    return render(
      <BookChangesProvider>
        <SearchPage />
      </BookChangesProvider>
    );
  }

  function type(value: string) {
    fireEvent.change(screen.getByPlaceholderText(/Search transactions/), { target: { value } });
  }

  it("runs the same search again when another client adds a payee", async () => {
    renderLive();
    type("star");
    await screen.findByText("Starbucks");

    payees = [payee(10, "Starbucks"), payee(11, "Starbucks Reserve")];
    hint(["payees"]);

    expect(await screen.findByText("Starbucks Reserve")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search transactions/)).toHaveValue("star");
    const urls = searches().map(([input]) => String(input));
    expect(urls[urls.length - 1]).toBe("/api/b/1/search?q=star");
  });

  it("keeps the results on the screen while it searches again", async () => {
    renderLive();
    type("star");
    await screen.findByText("Starbucks");

    hold = [];
    payees = [payee(10, "Starbucks"), payee(11, "Starbucks Reserve")];
    hint(["transactions"]);
    await waitFor(() => expect(hold).toHaveLength(1));

    expect(screen.queryByText("Searching...")).not.toBeInTheDocument();
    expect(screen.getByText("Starbucks")).toBeInTheDocument();

    await act(async () => { hold![0](); });
    expect(await screen.findByText("Starbucks Reserve")).toBeInTheDocument();
  });

  it("does not search for a table that it does not read", async () => {
    renderLive();
    type("star");
    await screen.findByText("Starbucks");
    const before = searches().length;

    hint(["security_prices"]);
    await settle();

    expect(searches()).toHaveLength(before);
  });

  it("does not search when the query is empty", async () => {
    renderLive();
    await settle();

    hint(["transactions"]);
    await settle();

    expect(searches()).toHaveLength(0);
  });
});
