import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";

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

  // The settings modal in BookNavbar calls setTheme with each of the three
  // values. Each value must reach the consumers and the document class.
  it("applies each theme to consumers and to the document", () => {
    function SetThemeButtons() {
      const { setTheme } = useTheme();
      return (
        <>
          <button onClick={() => setTheme("light")}>Light</button>
          <button onClick={() => setTheme("dark")}>Dark</button>
          <button onClick={() => setTheme("system")}>System</button>
        </>
      );
    }

    render(
      <ThemeProvider>
        <SetThemeButtons />
        <ThemeDisplay />
      </ThemeProvider>
    );
    const root = document.documentElement;

    fireEvent.click(screen.getByText("Light"));
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(root).not.toHaveClass("dark");

    fireEvent.click(screen.getByText("Dark"));
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(root).toHaveClass("dark");

    // The matchMedia mock reports a light system preference.
    fireEvent.click(screen.getByText("System"));
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(root).not.toHaveClass("dark");
  });
});
