import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookRoleProvider, useBookRole } from "@/components/BookRoleProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

function Probe() {
  const { role, canWrite, isOwner, members, status, refresh } = useBookRole();
  return (
    <>
      <p>{`${role}|${canWrite}|${isOwner}|${members.length}`}</p>
      <p data-testid="status">{status}</p>
      <button type="button" onClick={refresh}>Refresh</button>
    </>
  );
}

function renderProvider() {
  return render(
    <ToastProvider>
      <BookRoleProvider><Probe /></BookRoleProvider>
    </ToastProvider>
  );
}

const failure = () => ({ ok: false, status: 500, json: async () => ({ error: "Internal error" }) }) as Response;

function stub(role: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "B", upcomingDays: 30, userId: 1, role }] } as Response;
    if (url === "/api/books/1/members") return { ok: true, json: async () => [{ userId: 1, username: "a", role: "owner", createdAt: "" }, { userId: 2, username: "b", role, createdAt: "" }] } as Response;
    if (url === "/api/auth/me") return { ok: true, json: async () => ({ id: 2, username: "b" }) } as Response;
    throw new Error(`Unexpected fetch url: ${url}`);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("BookRoleProvider", () => {
  it("gives a viewer no write access", async () => {
    stub("viewer");
    render(<BookRoleProvider><Probe /></BookRoleProvider>);
    await waitFor(() => expect(screen.getByText("viewer|false|false|2")).toBeInTheDocument());
  });

  it("gives an editor write access but not owner", async () => {
    stub("editor");
    render(<BookRoleProvider><Probe /></BookRoleProvider>);
    await waitFor(() => expect(screen.getByText("editor|true|false|2")).toBeInTheDocument());
  });

  it("gives an owner owner access once the role loads", async () => {
    stub("owner");
    renderProvider();
    await waitFor(() => expect(screen.getByText("owner|true|true|2")).toBeInTheDocument());
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
  });

  it("gives least privilege while the role loads", () => {
    // The requests never answer, so the role stays unknown.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderProvider();
    expect(screen.getByText("viewer|false|false|0")).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
  });

  it("gives least privilege and shows an error when the role does not load", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return failure();
      if (url === "/api/books/1/members") return { ok: true, json: async () => [] } as Response;
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ id: 1, username: "a" }) } as Response;
      throw new Error(`Unexpected fetch url: ${url}`);
    }));
    renderProvider();

    expect(await screen.findByText(/Could not load your role in this book/)).toBeInTheDocument();
    expect(screen.getByText("viewer|false|false|0")).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("error");
  });

  it("drops an owner to least privilege when a later load fails", async () => {
    stub("owner");
    renderProvider();
    await waitFor(() => expect(screen.getByText("owner|true|true|2")).toBeInTheDocument());

    vi.stubGlobal("fetch", vi.fn(async () => failure()));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(/Could not load your role in this book/)).toBeInTheDocument();
    expect(screen.getByText(/^viewer\|false\|false\|/)).toBeInTheDocument();
  });

  it("shows an error when the members do not load", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/books") return { ok: true, json: async () => [{ id: 1, name: "B", upcomingDays: 30, userId: 1, role: "owner" }] } as Response;
      if (url === "/api/books/1/members") return failure();
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ id: 1, username: "a" }) } as Response;
      throw new Error(`Unexpected fetch url: ${url}`);
    }));
    renderProvider();

    expect(await screen.findByText(/Could not load the members of this book/)).toBeInTheDocument();
    // The role came from the books list, so it is still known.
    expect(screen.getByText("owner|true|true|0")).toBeInTheDocument();
  });

  it("gives owner access outside the provider", () => {
    render(<Probe />);
    expect(screen.getByText("owner|true|true|0")).toBeInTheDocument();
  });
});
