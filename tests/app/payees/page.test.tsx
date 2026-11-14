import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PayeesPage from "@/app/b/[bookId]/payees/page";
import { BookChangesProvider } from "@/components/BookChangesProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { FakeWebSocket } from "@/tests/helpers/web-socket";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

describe("PayeesPage", () => {
  const getRenderedPayeeOrder = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => {
        const link = within(row).getByRole("link");
        return link.textContent;
      });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters payees by partial name match", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              name: "Blue Bottle Coffee",
              lastTransactionDate: "2024-01-05",
              transactionCount: 4,
            },
            {
              id: 2,
              name: "City Utilities",
              lastTransactionDate: "2024-01-07",
              transactionCount: 2,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeesPage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Blue Bottle Coffee" })).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText("Search payees");
    fireEvent.change(searchInput, { target: { value: "bOTTL" } });

    expect(screen.getByRole("link", { name: "Blue Bottle Coffee" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "City Utilities" })).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "rent" } });

    expect(screen.getByText("No payees match your search.")).toBeInTheDocument();
  });

  it("shows last transaction dates and toggles sorting by column header", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        return {
          ok: true,
          json: async () => [
            {
              id: 1,
              name: "Charlie Grocer",
              lastTransactionDate: null,
              transactionCount: 2,
            },
            {
              id: 2,
              name: "Alpha Coffee",
              lastTransactionDate: "2024-02-01",
              transactionCount: 4,
            },
            {
              id: 3,
              name: "Bravo Utilities",
              lastTransactionDate: "2024-04-10",
              transactionCount: 2,
            },
          ],
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PayeesPage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Alpha Coffee" })).toBeInTheDocument();
    });

    expect(screen.getByText("Feb 1, 2024")).toBeInTheDocument();
    expect(screen.getByText("Apr 10, 2024")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Bravo Utilities",
      "Charlie Grocer",
      "Alpha Coffee",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Transactions" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Last transaction" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Alpha Coffee",
      "Bravo Utilities",
      "Charlie Grocer",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Last transaction" }));
    expect(getRenderedPayeeOrder()).toEqual([
      "Bravo Utilities",
      "Alpha Coffee",
      "Charlie Grocer",
    ]);
  });
});

// Another client (an MCP tool, a second tab, the importer) changes the book.
// The server sends the book socket a hint for each changed table, and the
// list must show the change without a reload.
describe("PayeesPage live updates", () => {
  const payee = (id: number, name: string, transactionCount = 1) => ({
    id, name, lastTransactionDate: "2024-01-05", transactionCount,
  });

  function socket() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  function hint(tables: string[]) {
    act(() => { socket().emit("change", { tables }); });
  }

  function renderLive() {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    return render(
      <ToastProvider>
        <BookChangesProvider>
          <PayeesPage />
        </BookChangesProvider>
      </ToastProvider>
    );
  }

  function serve(rows: () => unknown) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/b/1/payees")) {
        const body = rows();
        return body instanceof Error
          ? ({ ok: false, status: 500, json: async () => ({ error: "down" }) } as Response)
          : ({ ok: true, status: 200, json: async () => body } as Response);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a payee that another client created and keeps the search text", async () => {
    let rows: unknown = [payee(1, "Blue Bottle Coffee"), payee(2, "City Utilities")];
    vi.stubGlobal("fetch", serve(() => rows));

    renderLive();
    await screen.findByRole("link", { name: "Blue Bottle Coffee" });
    fireEvent.change(screen.getByLabelText("Search payees"), { target: { value: "bottle" } });
    expect(screen.queryByRole("link", { name: "City Utilities" })).not.toBeInTheDocument();

    rows = [payee(1, "Blue Bottle Coffee"), payee(2, "City Utilities"), payee(3, "Bottle Shop")];
    hint(["payees"]);

    expect(await screen.findByRole("link", { name: "Bottle Shop" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search payees")).toHaveValue("bottle");
    expect(screen.queryByRole("link", { name: "City Utilities" })).not.toBeInTheDocument();
  });

  it("updates the counts when another client adds a transaction", async () => {
    let rows: unknown = [payee(1, "Blue Bottle Coffee", 4)];
    vi.stubGlobal("fetch", serve(() => rows));

    renderLive();
    await screen.findByText("4");

    rows = [payee(1, "Blue Bottle Coffee", 5)];
    hint(["transactions"]);

    expect(await screen.findByText("5")).toBeInTheDocument();
  });

  it("does not reload for a table that it does not show", async () => {
    const fetchMock = serve(() => [payee(1, "Blue Bottle Coffee")]);
    vi.stubGlobal("fetch", fetchMock);

    renderLive();
    await screen.findByRole("link", { name: "Blue Bottle Coffee" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hint(["securities", "security_prices", "recurring_rules"]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the list when a background reload fails", async () => {
    let rows: unknown = [payee(1, "Blue Bottle Coffee")];
    vi.stubGlobal("fetch", serve(() => rows));

    renderLive();
    await screen.findByRole("link", { name: "Blue Bottle Coffee" });

    rows = new Error("down");
    hint(["payees"]);

    expect(await screen.findByText("Could not refresh payees.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blue Bottle Coffee" })).toBeInTheDocument();
    expect(screen.queryByText("Could not load payees.")).not.toBeInTheDocument();
  });
});
