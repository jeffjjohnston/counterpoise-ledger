import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KeyboardShortcutOverlay } from "@/components/ui/KeyboardShortcutOverlay";
import {
  KeyboardShortcutProvider,
  useKeyboardShortcuts,
  SHORTCUT_CATEGORIES,
  type ShortcutDef,
} from "@/components/KeyboardShortcutProvider";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ bookId: "1" }),
}));

// ---- Helper wrapper ----

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardShortcutProvider>
      {children}
      <KeyboardShortcutOverlay />
    </KeyboardShortcutProvider>
  );
}

/** Opens the overlay via context */
function OpenOverlayButton() {
  const { setOverlayOpen } = useKeyboardShortcuts();
  return <button onClick={() => setOverlayOpen(true)}>Open shortcuts</button>;
}

/** Registers page shortcuts */
function PageShortcuts({ shortcuts }: { shortcuts: ShortcutDef[] }) {
  const { registerShortcuts } = useKeyboardShortcuts();
  return (
    <button onClick={() => registerShortcuts(shortcuts)}>
      Register shortcuts
    </button>
  );
}

describe("KeyboardShortcutOverlay", () => {
  it("is not rendered when overlay is closed", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );
    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("renders when overlay is open", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
  });

  it("renders shortcut descriptions from context", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    // Global shortcuts should appear
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Go to Transactions")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("renders page-scoped shortcuts after they are registered", () => {
    const pageShortcuts: ShortcutDef[] = [
      {
        id: "page-new",
        keys: ["n"],
        description: "Create new item",
        category: "Page",
        action: vi.fn(),
      },
    ];

    render(
      <Wrapper>
        <PageShortcuts shortcuts={pageShortcuts} />
        <OpenOverlayButton />
      </Wrapper>
    );

    // Register page shortcuts first
    fireEvent.click(screen.getByText("Register shortcuts"));

    // Open the overlay
    fireEvent.click(screen.getByText("Open shortcuts"));

    expect(screen.getByText("Create new item")).toBeInTheDocument();
  });

  it("renders key labels in kbd elements", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    // kbd elements are rendered for each key in each shortcut
    const kbds = document.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });

  it("renders two-key sequences with 'then' separator", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    // Two-key shortcuts (like "g d") render "then" between keys
    const thenLabels = screen.getAllByText("then");
    expect(thenLabels.length).toBeGreaterThan(0);
  });

  it("groups shortcuts by category with category headers", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    // "General" and "Navigation" are categories from global shortcuts
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
  });

  it("closes when the close button is clicked", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("closes when clicking the backdrop", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();

    // The backdrop is the outermost fixed div; clicking it (as the target) closes the overlay.
    // We fire the click on the backdrop element itself.
    const backdrop = document.querySelector(
      '[class*="fixed inset-0"]'
    ) as HTMLElement | null;
    if (backdrop) {
      // Simulate clicking directly on the backdrop (not on a child)
      fireEvent.click(backdrop, { target: backdrop });
    }

    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("closes on pressing '?' key when overlay is open", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "?" });

    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("shows '?' shortcut with correct description", () => {
    render(
      <Wrapper>
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Open shortcuts"));

    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("renders Page category when page shortcuts exist", () => {
    const pageShortcuts: ShortcutDef[] = [
      {
        id: "page-edit",
        keys: ["e"],
        description: "Edit selected",
        category: "Page",
        action: vi.fn(),
      },
    ];

    render(
      <Wrapper>
        <PageShortcuts shortcuts={pageShortcuts} />
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register shortcuts"));
    fireEvent.click(screen.getByText("Open shortcuts"));

    expect(screen.getByText("Page")).toBeInTheDocument();
    expect(screen.getByText("Edit selected")).toBeInTheDocument();
  });

  // The overlay's ordering used to be a hand-maintained allowlist, separate
  // from the categories components actually register under, and it filtered
  // rather than sorted — so a category in one list and not the other lost its
  // shortcuts silently. That is why the price entry pill's P never appeared
  // here. SHORTCUT_CATEGORIES is now the single list both sides read, and this
  // test walks it, so a category added later is covered the day it is added.
  it("renders a shortcut registered under every declared category", () => {
    const probes: ShortcutDef[] = SHORTCUT_CATEGORIES.map((category, i) => ({
      id: `probe-${category}`,
      keys: [String(i)],
      description: `Probe ${category}`,
      category,
      action: vi.fn(),
    }));

    render(
      <Wrapper>
        <PageShortcuts shortcuts={probes} />
        <OpenOverlayButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByText("Register shortcuts"));
    fireEvent.click(screen.getByText("Open shortcuts"));

    for (const category of SHORTCUT_CATEGORIES) {
      expect(screen.getByText(category)).toBeInTheDocument();
      expect(screen.getByText(`Probe ${category}`)).toBeInTheDocument();
    }
  });
});
