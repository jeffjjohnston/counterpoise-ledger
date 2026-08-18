import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/ui/ToastProvider";
import { readFileSync } from "node:fs";

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  onReady(toast);
  return <div>harness</div>;
}

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders an error message raised through the hook", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => api.error("Failed to delete account"));
    expect(screen.getByText("Failed to delete account")).toBeInTheDocument();
  });

  it("stacks two messages raised in quick succession rather than clobbering", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => {
      api.error("First failure");
      api.error("Second failure");
    });

    // Both visible. A singular toast would have dropped the first.
    expect(screen.getByText("First failure")).toBeInTheDocument();
    expect(screen.getByText("Second failure")).toBeInTheDocument();
  });

  it("dismisses a success toast after its duration", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => api.success("3 prices saved"));
    expect(screen.getByText("3 prices saved")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("3 prices saved")).not.toBeInTheDocument();
  });

  it("gives an error toast longer on screen than a success toast", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => api.error("Something broke"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // A failure the user must read outlives the success confirmation duration.
    expect(screen.getByText("Something broke")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();
  });

  it("keeps each toast on its own timer when another is raised mid-flight", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => {
      api.error("First");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      api.error("Second"); // must not restart First's timer
    });
    act(() => {
      vi.advanceTimersByTime(4000); // First is now 5000ms old
    });
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("styles an error distinctly from a success", () => {
    let api!: ReturnType<typeof useToast>;
    render(
      <ToastProvider>
        <Harness onReady={(a) => (api = a)} />
      </ToastProvider>
    );

    act(() => api.error("Boom"));
    const pill = screen.getByText("Boom");
    expect(pill.className).toContain("bg-danger");
  });

  // Matches KeyboardShortcutProvider's no-op context default. Without this,
  // ~14 existing test files that render pages bare would all throw.
  it("does not throw when used outside a provider", () => {
    let api!: ReturnType<typeof useToast>;
    render(<Harness onReady={(a) => (api = a)} />);
    expect(() => api.error("ignored")).not.toThrow();
  });
});

describe("provider mounting", () => {
  // useToast() no-ops outside a provider, so an unmounted provider would make
  // every error message in the app silently vanish with nothing failing. That
  // is the one failure mode the no-op default cannot catch at runtime, and
  // rendering the root layout directly is impractical (it emits <html>/<body>),
  // so this asserts on the source instead.
  it("is mounted in the root layout", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).toContain('from "@/components/ui/ToastProvider"');
    expect(layout).toContain("<ToastProvider>");
  });
});
