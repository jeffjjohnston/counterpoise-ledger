// tests/components/layout/Navbar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/ThemeToggle", () => ({
  ThemeToggle: () => <button>Theme</button>,
}));

import { usePathname } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";

describe("Navbar", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("renders the app name", () => {
    render(<Navbar />);
    expect(screen.getByText("Counterpoise")).toBeInTheDocument();
  });

  it("renders all navigation links", () => {
    render(<Navbar />);

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("Payees")).toBeInTheDocument();
    expect(screen.getByText("Securities")).toBeInTheDocument();
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    expect(screen.getByText("Sync")).toBeInTheDocument();
  });

  it("renders ThemeToggle", () => {
    render(<Navbar />);
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("applies active styling to current route", () => {
    vi.mocked(usePathname).mockReturnValue("/transactions");

    render(<Navbar />);
    const transactionsLink = screen.getByRole("link", { name: "Transactions" });
    expect(transactionsLink.className).toContain("border-fg-accent");
  });

  it("does not apply active styling to inactive routes", () => {
    vi.mocked(usePathname).mockReturnValue("/transactions");

    render(<Navbar />);
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.className).not.toContain("border-fg-accent");
    expect(dashboardLink.className).toContain("border-transparent");
  });
});
