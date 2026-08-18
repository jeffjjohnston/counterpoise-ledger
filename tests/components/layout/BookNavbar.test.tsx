import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BookNavbar } from "@/components/layout/BookNavbar";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/b/1/transactions",
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({ bookId: "1" }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("BookNavbar", () => {
  afterEach(() => {
    pushMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the Settings modal from the user dropdown", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/books") {
        return {
          ok: true,
          json: async () => [{ id: 1, name: "Primary Book" }],
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<BookNavbar />);

    await waitFor(() => {
      expect(screen.getByText("Primary Book")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Open user menu"));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toHaveValue("system");
    expect(screen.getByRole("link", { name: "Open account page" })).toHaveAttribute("href", "/account");
  });

  it("shows Sign out in the user dropdown", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<BookNavbar />);

    await waitFor(() => {
      expect(screen.getByText("Primary Book")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Open user menu"));

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows active nav link with bottom border class, not background pill", async () => {
    // usePathname is mocked to "/b/1/transactions" at file top
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<BookNavbar />);
    await waitFor(() => expect(screen.getByText("Primary Book")).toBeInTheDocument());

    const transactionsLink = screen.getByRole("link", { name: "Transactions" });
    expect(transactionsLink).toHaveClass("border-b-2");
    expect(transactionsLink).toHaveClass("border-fg-accent");
    expect(transactionsLink).not.toHaveClass("bg-accent-subtle");

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink).not.toHaveClass("border-fg-accent");
    expect(dashboardLink).toHaveClass("border-transparent");
  });

  it("shows primary nav items and hides secondary items behind More", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<BookNavbar />);
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

  it("reveals Accounts, Payees, and Reports when More is clicked", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 1, name: "Primary Book" }],
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    render(<BookNavbar />);
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

    render(<BookNavbar />);
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
        return {
          ok: true,
          json: async () => [{ id: 1, name: "Primary Book" }],
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

    render(<BookNavbar />);

    expect(await screen.findByRole("button", { name: /1 price due/ })).toBeInTheDocument();
  });
});
