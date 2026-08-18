import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginForm } from "@/app/login/LoginForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("LoginForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders login form with accessible field labels", () => {
    render(<LoginForm registrationOpen={true} />);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows brand mark icon with accessible label", () => {
    render(<LoginForm registrationOpen={true} />);
    expect(screen.getByRole("img", { name: "Counterpoise" })).toBeInTheDocument();
  });

  it("shows error message returned from the API on failed login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Invalid credentials" }),
      } as Response))
    );

    render(<LoginForm registrationOpen={true} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("hides the register link when registration is closed", () => {
    render(<LoginForm registrationOpen={false} />);

    expect(screen.queryByRole("link", { name: /register/i })).toBeNull();
  });

  it("shows the register link when registration is open", () => {
    render(<LoginForm registrationOpen={true} />);

    expect(screen.getByRole("link", { name: /register/i })).toBeInTheDocument();
  });
});
