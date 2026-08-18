import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

function ThemeDisplay() {
  const { theme, resolvedTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to system theme", () => {
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );
    expect(screen.getByTestId("theme").textContent).toBe("system");
  });

  it("provides setTheme that updates localStorage", () => {
    function SetThemeButton() {
      const { setTheme } = useTheme();
      return <button onClick={() => setTheme("dark")}>Set Dark</button>;
    }

    render(
      <ThemeProvider>
        <SetThemeButton />
        <ThemeDisplay />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByText("Set Dark"));
    expect(localStorageMock.setItem).toHaveBeenCalledWith("theme", "dark");
  });
});

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    document.documentElement.classList.remove("dark");
  });

  it("renders a button with theme label", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("Theme:"));
  });

  it("cycles through themes: system -> light -> dark -> system", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
        <ThemeDisplay />
      </ThemeProvider>
    );

    const button = screen.getByRole("button");

    // Initial: system
    expect(screen.getByTestId("theme").textContent).toBe("system");

    // Cycle logic in ThemeToggle: light->dark, dark->system, else(system)->light
    fireEvent.click(button);
    expect(screen.getByTestId("theme").textContent).toBe("light");

    fireEvent.click(button);
    expect(screen.getByTestId("theme").textContent).toBe("dark");

    fireEvent.click(button);
    expect(screen.getByTestId("theme").textContent).toBe("system");
  });
});
