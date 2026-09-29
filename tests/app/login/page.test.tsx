import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginForm } from "@/app/login/LoginForm";
import { REGISTRATION_STATUS_TIMEOUT_MS } from "@/hooks/useRegistrationOpen";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useRouter: () => ({ push: vi.fn() }),
  })
);

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Answers the registration gate with `open`, and every other request with `other`. */
function stubFetch(open: boolean, other: () => Response = () => jsonResponse(200, {})) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === "/api/auth/registration-open" ? jsonResponse(200, { open }) : other()
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A request that never answers, and rejects only when its signal aborts. */
function stalledFetch() {
  return vi.fn(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
  );
}

describe("LoginForm", () => {
  beforeEach(() => {
    stubFetch(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders login form with accessible field labels", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows brand mark icon with accessible label", () => {
    render(<LoginForm />);
    expect(screen.getByRole("img", { name: "Counterpoise" })).toBeInTheDocument();
  });

  it("shows error message returned from the API on failed login", async () => {
    stubFetch(true, () => jsonResponse(401, { error: "Invalid credentials" }));

    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("hides the register link when registration is closed", async () => {
    const fetchMock = stubFetch(false);
    render(<LoginForm />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/registration-open", expect.anything()));
    // Let the response settle, then check that the link did not appear.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link", { name: /register/i })).toBeNull();
  });

  it("shows the register link when registration is open", async () => {
    render(<LoginForm />);

    expect(await screen.findByRole("link", { name: /register/i })).toHaveAttribute("href", "/register");
  });

  it("shows no register link until the gate answers", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<LoginForm />);

    expect(screen.queryByRole("link", { name: /register/i })).toBeNull();
  });

  it("shows no register link when the gate request fails", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: "Failed to check registration" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<LoginForm />);

    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /register/i })).toBeNull();
  });

  it("shows no register link when the gate request does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", stalledFetch());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<LoginForm />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTRATION_STATUS_TIMEOUT_MS);
    });
    expect(warn).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /register/i })).toBeNull();
  });
});
