import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BookSelectorPage from "@/app/page";
import { ToastProvider } from "@/components/ui/ToastProvider";

// Declared before vi.mock so the mocked useRouter's closure can return a
// single stable push mock across re-renders (see BookNavbar.test.tsx for the
// same pattern). This works despite vi.mock's hoisting: the factory below
// only *closes over* pushMock inside a nested function that isn't invoked
// until the component actually calls useRouter(), by which point this
// top-level `const` has already been initialized.
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

type Book = {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type IssueReport = {
  id: number;
  description: string;
  type: string;
  page: string;
  status: string;
  createdAt: string;
};

function createJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
  } as Response;
}

// `demoHook` lets a test own the /api/books/demo response — to hold it open
// while asserting the pending state, or to fail it. Without one, the stub
// behaves like the real route and returns a created book.
function stubFetch(
  initialBooks: Book[],
  initialIssues: IssueReport[] = [],
  demoHook?: () => Promise<Response>
) {
  const books = initialBooks.map((b) => ({ ...b }));
  const issues = initialIssues.map((i) => ({ ...i }));

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    // Book handlers
    if (url === "/api/books" && method === "GET") {
      return createJsonResponse([...books]);
    }
    if (url.startsWith("/api/books/") && method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse((init?.body as string) || "{}") as { name?: string };
      const book = books.find((item) => item.id === id);
      if (!book || !body.name) return createJsonResponse({ error: "Book not found" }, false, 404);
      book.name = body.name;
      book.updatedAt = "2026-02-11T00:00:00.000Z";
      return createJsonResponse(book);
    }
    if (url.startsWith("/api/books/") && method === "DELETE") {
      const id = Number(url.split("/").pop());
      const index = books.findIndex((item) => item.id === id);
      if (index < 0) return createJsonResponse({ error: "Book not found" }, false, 404);
      books.splice(index, 1);
      return createJsonResponse({ success: true });
    }
    if (url === "/api/books" && method === "POST") {
      return createJsonResponse({ error: "Unexpected create call in test" }, false, 500);
    }
    if (url === "/api/books/demo" && method === "POST") {
      if (demoHook) return demoHook();
      const created = {
        id: Math.max(0, ...books.map((item) => item.id)) + 1,
        name: "Demo Book",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      };
      books.push(created);
      return createJsonResponse(created);
    }

    // Issue reports handlers
    if (url === "/api/issue-reports" && method === "GET") {
      return createJsonResponse([...issues]);
    }
    if (url.match(/\/api\/issue-reports\/\d+$/) && method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse((init?.body as string) || "{}");
      const issue = issues.find((i) => i.id === id);
      if (!issue) return createJsonResponse({ error: "Not found" }, false, 404);
      Object.assign(issue, body);
      return createJsonResponse({ ...issue });
    }
    if (url.match(/\/api\/issue-reports\/\d+$/) && method === "DELETE") {
      const id = Number(url.split("/").pop());
      const index = issues.findIndex((i) => i.id === id);
      if (index < 0) return createJsonResponse({ error: "Not found" }, false, 404);
      issues.splice(index, 1);
      return createJsonResponse({ success: true });
    }

    // The page renders <JobStatusTable />, which fetches this on mount.
    if (url === "/api/system/status" && method === "GET") {
      return createJsonResponse({ overall: "unknown", jobs: [] });
    }

    throw new Error(`Unexpected fetch url: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("BookSelectorPage", () => {
  afterEach(() => {
    pushMock.mockClear();
    vi.restoreAllMocks();
  });

  it("opens an edit modal from the books list with warning text", async () => {
    stubFetch([
      {
        id: 1,
        name: "Family Finances",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<BookSelectorPage />);

    await waitFor(() => {
      expect(screen.getByText("Family Finances")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Family Finances" }));

    expect(screen.getByRole("heading", { name: "Edit Book" })).toBeInTheDocument();
    expect(screen.getByLabelText("Book name")).toHaveValue("Family Finances");
    expect(screen.getByText("Danger zone")).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("renames a book from the edit modal", async () => {
    const fetchMock = stubFetch([
      {
        id: 1,
        name: "Family Finances",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<BookSelectorPage />);

    await waitFor(() => {
      expect(screen.getByText("Family Finances")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Family Finances" }));
    fireEvent.change(screen.getByLabelText("Book name"), {
      target: { value: "Household Ledger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit Book" })).not.toBeInTheDocument();
    });

    expect(screen.getByText("Household Ledger")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/books/1" && (init as RequestInit | undefined)?.method === "PUT"
      )
    ).toBe(true);
  });

  it("requires a second confirmation step before deleting a book", async () => {
    const fetchMock = stubFetch([
      {
        id: 1,
        name: "Family Finances",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);

    render(<BookSelectorPage />);

    await waitFor(() => {
      expect(screen.getByText("Family Finances")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Family Finances" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete book..." }));

    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Final confirmation required/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes, permanently delete" }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Family Finances")).not.toBeInTheDocument();
    });

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/api/books/1" && (init as RequestInit | undefined)?.method === "DELETE"
      )
    ).toBe(true);
  });

  describe("demo book", () => {
    it("adds the created demo book to the list", async () => {
      stubFetch([]);

      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Add demo book" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add demo book" }));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Demo Book" })).toBeInTheDocument();
      });
    });

    it("disables both create actions while the seed runs", async () => {
      // The real request runs the whole seed and takes seconds. Holding the
      // response open is the only way to assert what the user sees for most of
      // that time — a resolved promise would blow straight past it.
      let release!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      stubFetch([], [], () => pending);

      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Add demo book" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add demo book" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Creating demo book..." })).toBeDisabled();
      });
      expect(screen.getByPlaceholderText("Book name")).toBeDisabled();

      release(
        createJsonResponse({
          id: 7,
          name: "Demo Book",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        })
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Add demo book" })).toBeEnabled();
      });
      expect(screen.getByPlaceholderText("Book name")).toBeEnabled();
    });

    it("reports a failure and leaves the button usable", async () => {
      stubFetch([], [], async () =>
        createJsonResponse({ error: "Failed to create demo book" }, false, 500)
      );

      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Add demo book" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add demo book" }));

      await waitFor(() => {
        expect(screen.getByText("Failed to create demo book")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Add demo book" })).toBeEnabled();
    });
  });

  describe("Reported Issues section", () => {
    const sampleIssues: IssueReport[] = [
      {
        id: 1,
        description: "Dashboard balance is wrong",
        type: "bug",
        page: "/b/1",
        status: "new",
        createdAt: "2026-03-01T00:00:00.000Z",
      },
      {
        id: 2,
        description: "Add dark mode",
        type: "improvement",
        page: "/b/1/accounts",
        status: "resolved",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    it("defaults to showing only new issues and reveals all when toggled", async () => {
      stubFetch([], sampleIssues);
      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByText("Reported Issues")).toBeInTheDocument();
      });

      // Default: only the "new" issue is visible
      expect(screen.getByText("Dashboard balance is wrong")).toBeInTheDocument();
      expect(screen.queryByText("Add dark mode")).not.toBeInTheDocument();

      // Toggling "Show all" reveals the resolved issue too
      fireEvent.click(screen.getByLabelText("Show all"));

      expect(screen.getByText("Dashboard balance is wrong")).toBeInTheDocument();
      expect(screen.getByText("Add dark mode")).toBeInTheDocument();
    });

    it("opens edit modal and saves changes", async () => {
      const fetchMock = stubFetch([], sampleIssues);
      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByText("Dashboard balance is wrong")).toBeInTheDocument();
      });

      // Click Edit on the first issue
      const editButtons = screen.getAllByRole("button", { name: "Edit" });
      fireEvent.click(editButtons[0]);

      expect(screen.getByRole("heading", { name: "Edit Issue Report" })).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toHaveValue("Dashboard balance is wrong");

      // Change status
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "resolved" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(screen.queryByRole("heading", { name: "Edit Issue Report" })).not.toBeInTheDocument();
      });

      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            typeof url === "string" &&
            url.includes("/api/issue-reports/") &&
            (init as RequestInit | undefined)?.method === "PUT"
        )
      ).toBe(true);
    });

    it("deletes an issue from the edit modal", async () => {
      const confirmMock = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmMock);

      stubFetch([], sampleIssues);
      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByText("Dashboard balance is wrong")).toBeInTheDocument();
      });

      const editButtons = screen.getAllByRole("button", { name: "Edit" });
      fireEvent.click(editButtons[0]);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(confirmMock).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.queryByText("Dashboard balance is wrong")).not.toBeInTheDocument();
      });
    });

    it("shows 'No new issues.' by default and 'No reported issues.' when showing all", async () => {
      stubFetch([], []);
      render(<BookSelectorPage />);

      await waitFor(() => {
        expect(screen.getByText("No new issues.")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText("Show all"));
      expect(screen.getByText("No reported issues.")).toBeInTheDocument();
    });
  });

  describe("scheduled jobs section", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("renders the scheduled jobs section on the book listing page", async () => {
      stubFetch([]);

      render(<BookSelectorPage />);

      expect(
        await screen.findByRole("heading", { name: "Scheduled Jobs" })
      ).toBeInTheDocument();
    });

    it("places scheduled jobs before reported issues", async () => {
      // The section order is the requirement, not merely its presence.
      stubFetch([]);

      render(<BookSelectorPage />);

      const jobs = await screen.findByRole("heading", { name: "Scheduled Jobs" });
      const issues = screen.getByRole("heading", { name: "Reported Issues" });

      expect(
        jobs.compareDocumentPosition(issues) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });

  describe("sign out", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function stubFetchWithLogout(logoutOk: boolean) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";

        if (url === "/api/books" && method === "GET") return createJsonResponse([]);
        if (url === "/api/issue-reports" && method === "GET") return createJsonResponse([]);
        if (url === "/api/system/status" && method === "GET") {
          return createJsonResponse({ overall: "unknown", jobs: [] });
        }
        if (url === "/api/auth/logout" && method === "POST") {
          return logoutOk
            ? createJsonResponse({ success: true })
            : createJsonResponse({ error: "Failed to log out" }, false, 500);
        }

        throw new Error(`Unexpected fetch url: ${url} (${method})`);
      });

      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("does not navigate and tells the user they are still signed in when the logout request fails", async () => {
      stubFetchWithLogout(false);

      render(
        <ToastProvider>
          <BookSelectorPage />
        </ToastProvider>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

      // The safety-critical fact — that the session is still live — must
      // reach the user; a generic failure toast would not.
      expect(
        await screen.findByText(/still signed in/i)
      ).toBeInTheDocument();

      expect(pushMock).not.toHaveBeenCalled();
    });

    it("navigates to /login when the logout request succeeds", async () => {
      stubFetchWithLogout(true);

      render(
        <ToastProvider>
          <BookSelectorPage />
        </ToastProvider>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

      await waitFor(() => {
        expect(pushMock).toHaveBeenCalledWith("/login");
      });
    });
  });
});
