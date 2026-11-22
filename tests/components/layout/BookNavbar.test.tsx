import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookNavbar } from "@/components/layout/BookNavbar";
import { BookRoleProvider } from "@/components/BookRoleProvider";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

const pushMock = vi.fn();

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    usePathname: () => "/b/1/transactions",
    useRouter: () => ({ push: pushMock }),
    useParams: () => ({ bookId: "1" }),
  })
);

// BookRoleProvider also fetches /api/books/1/members and /api/auth/me. Some
// fetch mocks below answer only /api/books, or answer every URL alike. Those
// extra calls then fail, or return the wrong shape. The provider reports a
// failure with a toast, and no ToastProvider is mounted here. Members stays
// empty and the current user id stays null. Neither affects the assertions
// below.
const renderNavbar = () => render(<BookRoleProvider><BookNavbar /></BookRoleProvider>);

describe("BookNavbar", () => {
  afterEach(() => {
    pushMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Each poll wakes the server's Durable Object. The socket sends the Plaid
  // tables' changes, so the badge needs no poll while it is open.
  it("polls the pending count only while the book socket is not open", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances = [];
      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.spyOn(Math, "random").mockReturnValue(1);
      let polls = 0;
      let failing = false;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "Primary Book" }] } as Response;
        if (url.includes("/sync/pending-count")) {
          polls++;
          if (failing) return { ok: false, status: 503, json: async () => ({ error: "busy" }) } as Response;
          return { ok: true, json: async () => ({ count: 0 }) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }));
      const view = render(<BookChangesProvider><BookRoleProvider><BookNavbar /></BookRoleProvider></BookChangesProvider>);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(polls).toBe(1);
      const socket = FakeWebSocket.instances[0];
      // Readiness catches up once.
      socket.emit("ready");
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(polls).toBe(2);
      await act(() => vi.advanceTimersByTimeAsync(3 * 60_000));
      expect(polls).toBe(2);
      // A hint for the queue still refreshes the badge.
      socket.emit("change", { tables: ["plaid_transaction_reconciliation"] });
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(polls).toBe(3);
      // A read that fails is tried again at the next poll, socket or not,
      // and the polls stop once one succeeds.
      failing = true;
      socket.emit("change", { tables: ["plaid_accounts"] });
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(polls).toBe(4);
      failing = false;
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(polls).toBe(5);
      await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
      expect(polls).toBe(5);
      // A dropped socket, until the next one is ready: the poll runs.
      socket.drop(1013);
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(polls).toBe(6);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Settings item links to the settings page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "Primary Book", role: "owner" }] } as Response;
      // Both features are on, so no dot shows.
      if (url.includes("/settings/")) return { ok: true, json: async () => ({ enabled: true, configured: true }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Open user menu"));
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/b/1/settings");
    expect(screen.queryByTestId("new-feature-dot")).not.toBeInTheDocument();
  });

  it("the Settings item links to the features section when a new feature can be turned on", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "Primary Book", role: "owner" }] } as Response;
      if (url.includes("/settings/")) return { ok: true, json: async () => ({ enabled: false, configured: true }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
    renderNavbar();
    await waitFor(() => expect(screen.getAllByTestId("new-feature-dot").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("Open user menu"));
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/b/1/settings#features");
  });

  it("shows Sign out in the user dropdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();

    await waitFor(() => {
      expect(screen.getByText("Primary Book")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Open user menu"));

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("releases the body scroll lock when the viewport leaves the mobile range", async () => {
    // An iPad rotated from portrait to landscape crosses `lg` with the menu
    // still open. `lg:hidden` then removes the overlay AND the hamburger that
    // would close it, but the scroll lock keys off menu state alone — so the
    // body stays `overflow: hidden` on a desktop-width page with no visible
    // control to clear it. Rotating back and closing the menu is the only
    // recovery, and nothing on screen says so.
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    let matches = true; // start below lg, as a portrait iPad does
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
          void listeners.add(fn),
        removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
          void listeners.delete(fn),
      }))
    );
    const crossToDesktop = () => {
      matches = false;
      listeners.forEach((fn) => fn({ matches } as MediaQueryListEvent));
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Open menu"));
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => crossToDesktop());

    expect(document.body.style.overflow).toBe("");
    expect(screen.queryByLabelText("Close menu")).not.toBeInTheDocument();
  });

  it("propagates the navbar height down to the nav links", async () => {
    // The active-tab underline is a `border-b-2` on the link, so it only lands at
    // the base of the bar if the link is as tall as the bar. Any wrapper in
    // between that sizes to its content collapses the row to text height, which
    // floats the underline mid-bar and halves the touch target. Height propagates
    // only when each wrapper stretches itself, is stretched by its parent, or
    // takes the full height of its parent.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    const link = screen.getByRole("link", { name: "Transactions" });
    const collapsingWrappers: string[] = [];

    let el = link.parentElement;
    while (el && !/\bh-14\b/.test(el.className)) {
      const parent = el.parentElement;
      if (!parent) break;
      const stretches =
        /\bself-stretch\b/.test(el.className) ||
        /\bh-full\b/.test(el.className) ||
        /\bitems-stretch\b/.test(parent.className);
      if (!stretches) collapsingWrappers.push(el.className.trim());
      el = parent;
    }

    expect(collapsingWrappers).toEqual([]);
  });

  it("shows primary nav items and hides secondary items behind More", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    // Primary items are visible
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Transactions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Recurring" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Securities" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sync" })).toBeInTheDocument();

    // Secondary items NOT visible yet (hidden behind More)
    expect(screen.queryByRole("link", { name: "Accounts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Payees" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Income Statement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Custom Report" })).not.toBeInTheDocument();

    // More button exists
    expect(screen.getByRole("button", { name: /more/i })).toBeInTheDocument();
  });

  it("marks only the active desktop nav link with aria-current", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response)));

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    // The pathname is /b/1/transactions. Dashboard is /b/1, a prefix of that
    // path, and must still not be marked: it matches only its exact path.
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Transactions"]);
  });

  it("reveals Accounts, Payees, and Reports when More is clicked", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /more/i }));

    expect(screen.getByRole("link", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Payees" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Income Statement" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Custom Report" })).toBeInTheDocument();
  });

  it("marks the current book with aria-current in the book dropdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { id: 1, name: "Primary Book" },
        { id: 2, name: "Other Book" },
      ],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Open book menu"));

    // bookId is "1" from useParams mock — book 1 is current
    const bookLinks = screen.getAllByRole("link").filter(
      (l) => l.getAttribute("href") === "/b/1" || l.getAttribute("href") === "/b/2"
    );
    const currentBookLink = bookLinks.find((l) => l.getAttribute("href") === "/b/1");
    const otherBookLink = bookLinks.find((l) => l.getAttribute("href") === "/b/2");

    expect(currentBookLink).toHaveAttribute("aria-current", "page");
    expect(otherBookLink).not.toHaveAttribute("aria-current");
  });

  it("shows the price entry pill when manual prices are due", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/books") {
        // The pill is for a user who can write. The role comes from this
        // list. Without it the provider gives the least privilege.
        return {
          ok: true,
          json: async () => [{ id: 1, name: "Primary Book", upcomingDays: 30, userId: 1, role: "owner" }],
        } as Response;
      }
      if (url.includes("/sync/pending-count")) {
        return { ok: true, json: async () => ({ count: 0 }) } as Response;
      }
      if (url.includes("/securities/prices-due")) {
        return {
          ok: true,
          json: async () => ({
            dueDate: "2026-07-02",
            securities: [
              {
                securityId: 5,
                name: "SPY Jul '26 630C",
                symbol: "SPY260731C630",
                lastPriceMicros: 4_350_000,
                lastPriceDate: "2026-07-01",
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderNavbar();

    expect(await screen.findByRole("button", { name: /1 price due/ })).toBeInTheDocument();
  });

  it("shows a Read-only badge and no price entry for a viewer", async () => {
    // The prices-due stub answers with a due security — the same shape that
    // renders the pill for a writer in "shows the price entry pill when
    // manual prices are due" above. That proves the assertion below is
    // catching the canWrite gate, not an empty response that would leave the
    // pill unrendered either way.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "Shared", upcomingDays: 30, userId: 9, role: "viewer" }] } as Response;
      if (url.includes("/sync/pending-count")) return { ok: true, json: async () => ({ count: 0 }) } as Response;
      if (url.includes("/securities/prices-due")) {
        return {
          ok: true,
          json: async () => ({
            dueDate: "2026-07-02",
            securities: [
              {
                securityId: 5,
                name: "SPY Jul '26 630C",
                symbol: "SPY260731C630",
                lastPriceMicros: 4_350_000,
                lastPriceDate: "2026-07-01",
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }));
    renderNavbar();
    await waitFor(() => expect(screen.getByText("Read-only")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /price due/ })).not.toBeInTheDocument();
  });

  it("shows no Read-only badge while the role loads", async () => {
    // The books list never answers, so the role stays unknown. The provider
    // gives the least privilege, but the user is not known to be read-only.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return new Promise<Response>(() => {});
      return { ok: true, json: async () => ({}) } as Response;
    }));
    renderNavbar();
    await act(async () => {});
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });
});
