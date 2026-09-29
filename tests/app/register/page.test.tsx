import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RegisterForm } from "@/app/register/RegisterForm";
import { REGISTRATION_STATUS_TIMEOUT_MS } from "@/hooks/useRegistrationOpen";

const replace = vi.fn();

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useRouter: () => ({ push: vi.fn(), replace }),
  })
);

function stubRegistrationOpen(response: () => Promise<Response>) {
  const fetchMock = vi.fn(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function answer(status: number, body: unknown): () => Promise<Response> {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
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

describe("RegisterForm", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("when registration is open", () => {
    beforeEach(() => {
      stubRegistrationOpen(answer(200, { open: true }));
    });

    it("shows the form and does not redirect", async () => {
      render(<RegisterForm />);

      expect(await screen.findByTestId("register-ready")).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it("shows brand mark icon with accessible label", async () => {
      render(<RegisterForm />);
      expect(await screen.findByRole("img", { name: "Counterpoise" })).toBeInTheDocument();
    });

    it("shows error when passwords do not match", async () => {
      render(<RegisterForm />);
      fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "alice" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
      fireEvent.change(screen.getByLabelText("Confirm Password"), {
        target: { value: "different" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));

      await waitFor(() => {
        expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
      });
    });
  });

  it("goes to /login and shows no form when registration is closed", async () => {
    const fetchMock = stubRegistrationOpen(answer(200, { open: false }));
    render(<RegisterForm />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/registration-open", expect.anything());
    expect(screen.queryByTestId("register-ready")).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("goes to /login when the gate request fails", async () => {
    stubRegistrationOpen(answer(500, { error: "Failed to check registration" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<RegisterForm />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByTestId("register-ready")).toBeNull();
  });

  it("shows no form until the gate answers", () => {
    stubRegistrationOpen(() => new Promise<Response>(() => {}));
    render(<RegisterForm />);

    expect(screen.queryByTestId("register-ready")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes to /login when the gate request does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", stalledFetch());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<RegisterForm />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTRATION_STATUS_TIMEOUT_MS - 1);
    });
    expect(replace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByTestId("register-ready")).toBeNull();
  });
});
