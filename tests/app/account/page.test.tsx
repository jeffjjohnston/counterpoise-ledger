import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import AccountPage from "@/app/account/page";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("AccountPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits a password change request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/auth/me") {
        return {
          ok: true,
          json: async () => ({ id: 1, username: "alice" }),
        } as Response;
      }

      if (url === "/api/auth/password" && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountPage />);

    await waitFor(() => {
      expect(screen.getByText("Signed in as alice")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old-password-123" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password-123" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/password", {
        method: "PUT",
        // apiFetch normalizes headers through the Headers constructor (see
        // lib/api-client.ts) rather than a plain object, so it can accept
        // any HeadersInit shape from a caller without silently dropping it.
        headers: expect.any(Headers),
        body: JSON.stringify({
          currentPassword: "old-password-123",
          newPassword: "new-password-123",
        }),
      });
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect((putCall?.[1]?.headers as Headers).get("Content-Type")).toBe("application/json");

    expect(screen.getByText("Password updated successfully")).toBeInTheDocument();
  });

  it("shows validation errors when passwords do not match", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return {
          ok: true,
          json: async () => ({ id: 1, username: "alice" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AccountPage />);

    await waitFor(() => {
      expect(screen.getByText("Signed in as alice")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old-password-123" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password-123" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(screen.getByText("New password and confirmation do not match")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/auth/password",
      expect.objectContaining({ method: "PUT" })
    );
  });
});
