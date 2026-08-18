import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

// Mock the ThemeProvider module so we can control the theme value in tests
const mockSetTheme = vi.fn();
let mockTheme = "light";

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
    resolvedTheme: mockTheme === "system" ? "light" : mockTheme,
  }),
}));

describe("ThemeToggle", () => {
  beforeEach(() => {
    mockSetTheme.mockClear();
    mockTheme = "light";
  });

  it("renders without crashing", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("shows correct aria-label for light theme", () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Theme: light");
  });

  it("shows correct aria-label for dark theme", () => {
    mockTheme = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Theme: dark");
  });

  it("shows correct aria-label for system theme", () => {
    mockTheme = "system";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Theme: system");
  });

  it("cycles from light to dark on click", () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("cycles from dark to system on click", () => {
    mockTheme = "dark";
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("system");
  });

  it("cycles from system to light on click", () => {
    mockTheme = "system";
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("renders sun icon for light theme", () => {
    mockTheme = "light";
    const { container } = render(<ThemeToggle />);
    // Light theme uses the sun icon path (M12 3v1m0 16v1...)
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M12 3v1");
  });

  it("renders moon icon for dark theme", () => {
    mockTheme = "dark";
    const { container } = render(<ThemeToggle />);
    // Dark theme uses the moon icon path (M20.354 15.354...)
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M20.354");
  });

  it("renders monitor icon for system theme", () => {
    mockTheme = "system";
    const { container } = render(<ThemeToggle />);
    // System theme uses the monitor icon path (M9.75 17L9 20...)
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    const path = container.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M9.75 17");
  });

  it("calls setTheme exactly once per click", () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledTimes(1);
  });
});
