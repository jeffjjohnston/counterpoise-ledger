import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { BookRoleProvider } from "@/components/BookRoleProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { isDotCleared } from "@/lib/features";
import { BOOK_SESSION_ENDED_EVENT } from "@/lib/events";

// jsdom has no scrollIntoView. A no-op lets each test spy on it.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};

const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    usePathname: () => "/b/1/settings",
    useRouter: () => ({ push: pushMock, replace: replaceMock }),
    useParams: () => ({ bookId: "1" }),
  })
);

type Book = { id: number; name: string; upcomingDays: number; userId: number; role: string };

// The book as the server holds it. A test changes it to act as another device.
let book: Book;
let puts: Array<Record<string, unknown>>;
let putFails: boolean;
let deletes: string[];

const featureSettings = { enabled: false, configured: true, revision: 1, entrySuggestionsEnabled: false };

function stubServer() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url === "/api/books/1" && method === "PUT") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      puts.push(body);
      if (putFails) return { ok: false, status: 500, json: async () => ({ error: "Failed to update book" }) } as Response;
      book = { ...book, ...body };
      return { ok: true, json: async () => book } as Response;
    }
    if (url === "/api/books/1" && method === "DELETE") {
      deletes.push(url);
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    if (url === "/api/books") return { ok: true, json: async () => [book] } as Response;
    if (url === "/api/auth/me") return { ok: true, json: async () => ({ id: 1, username: "alice" }) } as Response;
    if (url === "/api/books/1/members") return { ok: true, json: async () => [] } as Response;
    if (url.includes("/settings/")) return { ok: true, json: async () => featureSettings } as Response;
    return { ok: true, json: async () => [] } as Response;
  }));
}

function renderPage() {
  return render(
    <ToastProvider>
      <BookRoleProvider>
        <SettingsPage bookId="1" />
      </BookRoleProvider>
    </ToastProvider>,
  );
}

async function renderLoaded() {
  const view = renderPage();
  await screen.findByText(`This book: ${book.name}`);
  return view;
}

describe("SettingsPage in a book", () => {
  beforeEach(() => {
    localStorage.clear();
    book = { id: 1, name: "Primary Book", upcomingDays: 30, userId: 1, role: "owner" };
    puts = [];
    putFails = false;
    deletes = [];
    stubServer();
  });

  afterEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("an owner sees Features, General, Members and Delete this book, in that order", async () => {
    await renderLoaded();
    const ids = [...document.querySelectorAll("section[id]")].map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["features", "general", "members", "danger"]);
  });

  it("a viewer sees no owner controls", async () => {
    book = { ...book, role: "viewer" };
    await renderLoaded();
    expect(screen.queryByLabelText("Book name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete book..." })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Upcoming recurring days")).not.toBeInTheDocument();
    expect(screen.getByText("Only an editor can change features.")).toBeInTheDocument();
    expect(screen.queryByText("Weekly review")).not.toBeInTheDocument();
  });

  it("rename sends only the name", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Book name"), { target: { value: "New name" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rename" })); });
    expect(puts).toEqual([{ name: "New name" }]);
    expect(await screen.findByText("This book: New name")).toBeInTheDocument();
  });

  it("deleting the book goes home, ends the book session, and leaves no Back entry", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const ended = vi.fn();
    window.addEventListener(BOOK_SESSION_ENDED_EVENT, ended);
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Delete book..." }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Yes, permanently delete" })); });
    expect(deletes).toEqual(["/api/books/1"]);
    expect(replaceMock).toHaveBeenCalledWith("/");
    expect(pushMock).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    window.removeEventListener(BOOK_SESSION_ENDED_EVENT, ended);
  });

  it("a new feature shows a New badge; a feature first seen 60 days ago does not", async () => {
    localStorage.setItem("counterpoise:feature-first-seen", JSON.stringify({ "weekly-review": "2000-01-01" }));
    await renderLoaded();
    const features = document.getElementById("features")!;
    expect(features.querySelectorAll("[data-feature-new]")).toHaveLength(1);
    expect(features.querySelector('[data-feature="typesafe"] [data-feature-new]')).not.toBeNull();
    expect(features.querySelector('[data-feature="weekly-review"] [data-feature-new]')).toBeNull();
  });

  it("opening the page clears the dot for the shown features", async () => {
    await renderLoaded();
    // The dot goes in an effect that runs when the role is known. The role
    // comes from a different request than the book name that renderLoaded
    // waits for, so it can arrive later.
    await waitFor(() => expect(isDotCleared("1", "typesafe")).toBe(true));
    expect(isDotCleared("1", "weekly-review")).toBe(true);
  });

  it("a page opened at another section keeps the dot, and shows it on Features in the side menu", async () => {
    window.location.hash = "#members";
    await renderLoaded();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const features = within(nav).getByRole("link", { name: /Features/ });
    expect(await within(features).findByTestId("new-feature-dot")).toBeInTheDocument();
    expect(isDotCleared("1", "typesafe")).toBe(false);
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "location");

    // The user goes to Features. The dot goes, in storage and in the menu.
    fireEvent.click(features);
    await waitFor(() => expect(isDotCleared("1", "typesafe")).toBe(true));
    expect(within(features).queryByTestId("new-feature-dot")).not.toBeInTheDocument();
    expect(features).toHaveAttribute("aria-current", "location");
  });

  it("a viewer's visit does not start the 60 days of New", async () => {
    book = { ...book, role: "viewer" };
    await renderLoaded();
    await act(async () => {});
    expect(localStorage.getItem("counterpoise:feature-first-seen")).toBeNull();
    expect(isDotCleared("1", "typesafe")).toBe(false);
  });

  it("the side menu marks the section that the user reads", async () => {
    await renderLoaded();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const current = () => within(nav).getAllByRole("link").filter((link) => link.getAttribute("aria-current")).map((link) => link.textContent);
    await waitFor(() => expect(current()).toEqual(["Features"]));
    fireEvent.click(within(nav).getByRole("link", { name: "API keys" }));
    expect(current()).toEqual(["API keys"]);
  });

  it("goes to the linked section again when content above it loads, until the user acts", async () => {
    let resized: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() { disconnect(); }
    });
    const scroll = vi.fn();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(scroll);
    window.location.hash = "#danger";
    await renderLoaded();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));

    // The members list loads and moves the section down.
    resized();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts[1]).toBe(document.getElementById("danger"));

    // The user scrolls. The page does not pull the user back after that.
    fireEvent.wheel(window);
    expect(disconnect).toHaveBeenCalled();
  });

  // A scrollbar drag sends no wheel, key or pointer event in some browsers.
  it("ends the hold on a scroll that moves the linked section, not on its own scroll", async () => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() { disconnect(); }
    });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    let top = 96;
    let contentHeight = 1000;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      // The section gives its position. Each other element gives the content size.
      return { top: this.id === "danger" ? top : 0, bottom: 0, width: 800, height: contentHeight } as DOMRect;
    });
    window.location.hash = "#danger";
    await renderLoaded();
    await waitFor(() => expect(document.getElementById("danger")).toBeInTheDocument());
    await act(async () => {});

    // The scroll event of the hold's own scroll: the section is where the hold put it.
    fireEvent.scroll(document);
    expect(disconnect).not.toHaveBeenCalled();

    // Content above the section loads and moves it. The observer has not run
    // yet in this frame; it will hold the section again.
    top = 250;
    contentHeight = 1154;
    fireEvent.scroll(document);
    expect(disconnect).not.toHaveBeenCalled();

    // The content is as before, the user drags the scrollbar, and the section moves.
    contentHeight = 1000;
    top = 300;
    fireEvent.scroll(document);
    expect(disconnect).toHaveBeenCalled();
  });

  it("a side-menu link scrolls to its section and sets the hash without a router navigation", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await renderLoaded();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("link", { name: "Members" }));
    expect(scroll.mock.contexts.at(-1)).toBe(document.getElementById("members"));
    expect(window.location.hash).toBe("#members");
  });

  it("scrolls to the hash section after load", async () => {
    const scroll = vi.fn();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(scroll);
    window.location.hash = "#features";
    await renderLoaded();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("features"));
  });

  describe("upcoming recurring days", () => {
    const field = () => screen.getByLabelText("Upcoming recurring days") as HTMLInputElement;

    // Holds the next request that `match` accepts until the test releases it.
    const holdNext = (match: (url: string, init?: RequestInit) => boolean) => {
      let release: () => void = () => undefined;
      let armed = true;
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (armed && match(input.toString(), init)) {
          armed = false;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return realFetch(input, init);
      }));
      return () => release();
    };
    const isPut = (url: string, init?: RequestInit) => url === "/api/books/1" && init?.method === "PUT";

    it("sends only upcomingDays, so it does not put back a name that another device changed", async () => {
      await renderLoaded();
      // Another device renames the book. This page has not read it yet.
      book = { ...book, name: "Renamed Elsewhere" };
      fireEvent.change(field(), { target: { value: "14" } });
      await act(async () => { fireEvent.blur(field()); });

      expect(puts).toEqual([{ upcomingDays: 14 }]);
      expect(field()).toHaveValue(14);
    });

    it("sends nothing when the value did not change", async () => {
      await renderLoaded();
      await act(async () => { fireEvent.blur(field()); });
      expect(puts).toEqual([]);
    });

    it("takes no input while a save is in flight, then shows the saved value", async () => {
      await renderLoaded();
      const release = holdNext(isPut);
      fireEvent.change(field(), { target: { value: "14" } });
      await act(async () => { fireEvent.blur(field()); });
      expect(field()).toBeDisabled();

      await act(async () => { release(); });
      expect(field()).toBeEnabled();
      expect(field()).toHaveValue(14);
      expect(puts).toEqual([{ upcomingDays: 14 }]);
    });

    it("uses the saved value at once, before the books read after the save ends", async () => {
      await renderLoaded();
      // The books read that follows the save does not return.
      holdNext((url, init) => url === "/api/books" && (init?.method ?? "GET") === "GET");
      fireEvent.change(field(), { target: { value: "14" } });
      await act(async () => { fireEvent.blur(field()); });
      expect(field()).toHaveValue(14);

      // A change back to 30 is a change: the server holds 14.
      fireEvent.change(field(), { target: { value: "30" } });
      await act(async () => { fireEvent.blur(field()); });
      expect(puts).toEqual([{ upcomingDays: 14 }, { upcomingDays: 30 }]);
      expect(book.upcomingDays).toBe(30);
    });

    it("keeps the field locked when the user leaves the page and comes back during a save", async () => {
      // The page unmounts, and the book layout (BookRoleProvider) stays.
      function Shell({ show }: { show: boolean }) {
        return (
          <ToastProvider>
            <BookRoleProvider>{show ? <SettingsPage bookId="1" /> : <p>elsewhere</p>}</BookRoleProvider>
          </ToastProvider>
        );
      }
      const { rerender } = render(<Shell show />);
      await screen.findByText("This book: Primary Book");
      const release = holdNext(isPut);
      fireEvent.change(field(), { target: { value: "14" } });
      await act(async () => { fireEvent.blur(field()); });

      rerender(<Shell show={false} />);
      expect(screen.queryByLabelText("Upcoming recurring days")).not.toBeInTheDocument();
      rerender(<Shell show />);
      expect(field()).toBeDisabled();

      await act(async () => { release(); });
      expect(field()).toBeEnabled();
      expect(field()).toHaveValue(14);
    });

    it("shows an error and puts back the saved value when the save fails", async () => {
      await renderLoaded();
      putFails = true;
      fireEvent.change(field(), { target: { value: "14" } });
      await act(async () => { fireEvent.blur(field()); });

      expect(puts).toEqual([{ upcomingDays: 14 }]);
      expect(await screen.findByText(/Failed to update book/)).toBeInTheDocument();
      expect(field()).toHaveValue(30);
    });
  });
});
