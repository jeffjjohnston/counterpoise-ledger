import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import {
  KeyboardShortcutProvider,
  useKeyboardShortcuts,
  type ShortcutDef,
} from "@/components/KeyboardShortcutProvider";

// Mock next/navigation — KeyboardShortcutProvider uses useRouter and useParams
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ bookId: "1" }),
}));

// ---- Helper components ----

/** Renders context values for inspection */
function ContextDisplay() {
  const { isOverlayOpen, allShortcuts, pendingPrefix } =
    useKeyboardShortcuts();
  return (
    <div>
      <span data-testid="overlay-open">{String(isOverlayOpen)}</span>
      <span data-testid="shortcut-count">{allShortcuts.length}</span>
      <span data-testid="pending-prefix">{pendingPrefix ?? "none"}</span>
    </div>
  );
}

/**
 * Registers shortcuts on click and stores the unregister fn in a ref
 * so it's stable across re-renders.
 */
function ShortcutRegistrar({
  shortcuts,
  label = "Register",
}: {
  shortcuts: ShortcutDef[];
  label?: string;
}) {
  const { registerShortcuts } = useKeyboardShortcuts();
  const unregisterRef = useRef<(() => void) | null>(null);

  return (
    <div>
      <button
        onClick={() => {
          unregisterRef.current = registerShortcuts(shortcuts);
        }}
      >
        {label}
      </button>
      <button
        onClick={() => {
          unregisterRef.current?.();
        }}
      >
        Unregister
      </button>
    </div>
  );
}

/** Wraps children in the provider */
function Wrapper({ children }: { children: React.ReactNode }) {
  return <KeyboardShortcutProvider>{children}</KeyboardShortcutProvider>;
}

describe("KeyboardShortcutProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("provides default context values", () => {
    render(
      <Wrapper>
        <ContextDisplay />
      </Wrapper>
    );
    expect(screen.getByTestId("overlay-open").textContent).toBe("false");
    expect(screen.getByTestId("pending-prefix").textContent).toBe("none");
  });

  it("includes global shortcuts in allShortcuts by default", () => {
    render(
      <Wrapper>
        <ContextDisplay />
      </Wrapper>
    );
    // There are 9 global shortcuts defined in the provider
    const count = parseInt(screen.getByTestId("shortcut-count").textContent!);
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it("registerShortcuts adds shortcuts to allShortcuts", () => {
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-new",
        keys: ["n"],
        description: "New item",
        category: "Page",
        action: vi.fn(),
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <ContextDisplay />
      </Wrapper>
    );

    const initialCount = parseInt(
      screen.getByTestId("shortcut-count").textContent!
    );

    fireEvent.click(screen.getByText("Register"));

    const newCount = parseInt(
      screen.getByTestId("shortcut-count").textContent!
    );
    expect(newCount).toBe(initialCount + 1);
  });

  it("unregistering removes shortcuts from allShortcuts", () => {
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-removable",
        keys: ["x"],
        description: "Removable",
        category: "Page",
        action: vi.fn(),
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <ContextDisplay />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register"));

    const afterRegister = parseInt(
      screen.getByTestId("shortcut-count").textContent!
    );

    fireEvent.click(screen.getByText("Unregister"));

    const afterUnregister = parseInt(
      screen.getByTestId("shortcut-count").textContent!
    );
    expect(afterUnregister).toBe(afterRegister - 1);
  });

  it("setOverlayOpen toggles isOverlayOpen", () => {
    function ToggleButton() {
      const { setOverlayOpen } = useKeyboardShortcuts();
      return (
        <button onClick={() => setOverlayOpen(true)}>Open overlay</button>
      );
    }

    render(
      <Wrapper>
        <ToggleButton />
        <ContextDisplay />
      </Wrapper>
    );

    expect(screen.getByTestId("overlay-open").textContent).toBe("false");

    fireEvent.click(screen.getByText("Open overlay"));

    expect(screen.getByTestId("overlay-open").textContent).toBe("true");
  });

  it("dispatches single-key shortcut actions on keydown", () => {
    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-single",
        keys: ["m"],
        description: "My action",
        category: "Page",
        action,
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <ContextDisplay />
      </Wrapper>
    );

    // Register the shortcut first
    fireEvent.click(screen.getByText("Register"));

    // Fire the keydown event on document
    fireEvent.keyDown(document, { key: "m" });

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("dispatches two-key sequence shortcut actions on keydown", () => {
    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-seq",
        keys: ["c", "o"],
        description: "Custom action",
        category: "Page",
        action,
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <ContextDisplay />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register"));

    // Fire first key — sets pending prefix
    fireEvent.keyDown(document, { key: "c" });

    // Pending prefix should be visible
    expect(screen.getByTestId("pending-prefix").textContent).toBe("c");

    // Fire second key — completes the sequence
    fireEvent.keyDown(document, { key: "o" });

    expect(action).toHaveBeenCalledTimes(1);
    // Pending prefix clears after completion
    expect(screen.getByTestId("pending-prefix").textContent).toBe("none");
  });

  it("does not dispatch shortcuts when typing in an input field", () => {
    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-no-input",
        keys: ["n"],
        description: "New",
        category: "Page",
        action,
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <input data-testid="text-input" />
        <ContextDisplay />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register"));

    // Focus the input so isTypingInField() returns true
    const input = screen.getByTestId("text-input");
    input.focus();
    fireEvent.keyDown(input, { key: "n" });

    expect(action).not.toHaveBeenCalled();
  });

  it("closes overlay on Escape when overlay is open", () => {
    function OpenButton() {
      const { setOverlayOpen } = useKeyboardShortcuts();
      return <button onClick={() => setOverlayOpen(true)}>Open</button>;
    }

    render(
      <Wrapper>
        <OpenButton />
        <ContextDisplay />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByTestId("overlay-open").textContent).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByTestId("overlay-open").textContent).toBe("false");
  });

  it("ignores shortcuts with Ctrl/Cmd/Alt modifiers", () => {
    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      {
        id: "test-no-modifier",
        keys: ["s"],
        description: "Save",
        category: "Page",
        action,
      },
    ];

    render(
      <Wrapper>
        <ShortcutRegistrar shortcuts={shortcuts} />
        <ContextDisplay />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register"));

    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    fireEvent.keyDown(document, { key: "s", metaKey: true });
    fireEvent.keyDown(document, { key: "s", altKey: true });

    expect(action).not.toHaveBeenCalled();
  });
});
