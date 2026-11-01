import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { NoteIndicator, placeNoteTooltip } from "@/components/transactions/NoteIndicator";

describe("NoteIndicator", () => {
  it("renders the note icon", () => {
    render(<NoteIndicator notes="A note" />);
    expect(screen.getByLabelText("Has notes")).toBeInTheDocument();
  });

  it("shows tooltip on hover", () => {
    render(<NoteIndicator notes="Hello world" />);

    const icon = screen.getByLabelText("Has notes");
    fireEvent.mouseEnter(icon.closest("span")!);

    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("hides tooltip on mouse leave", () => {
    render(<NoteIndicator notes="Hello world" />);

    const wrapper = screen.getByLabelText("Has notes").closest("span")!;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByText("Hello world")).toBeInTheDocument();

    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByText("Hello world")).not.toBeInTheDocument();
  });
});

describe("NoteIndicator popup position", () => {
  const viewport = { width: 1024, height: 768 };
  const icon = (top: number, left: number) => ({ top, bottom: top + 16, left, right: left + 16 });

  it("renders the popup outside a container that clips its content", () => {
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <NoteIndicator notes="Hello world" />
      </div>
    );

    fireEvent.mouseEnter(screen.getByLabelText("Has notes").closest("span")!);

    const tooltip = screen.getByRole("tooltip");
    expect(container.contains(tooltip)).toBe(false);
    expect(tooltip.parentElement).toBe(document.body);
  });

  it("opens above the icon when it fits there", () => {
    const position = placeNoteTooltip(icon(400, 500), 100, viewport);
    expect(position.placement).toBe("above");
    expect(position.top).toBe(400 - 8 - 100);
  });

  it("opens below an icon near the top of the window", () => {
    const position = placeNoteTooltip(icon(60, 500), 100, viewport);
    expect(position.placement).toBe("below");
    expect(position.top).toBe(60 + 16 + 8);
  });

  it("stays inside the window next to its left and right edges", () => {
    expect(placeNoteTooltip(icon(400, 0), 100, viewport).left).toBe(8);
    expect(placeNoteTooltip(icon(400, 1010), 100, viewport).left).toBe(1024 - 256 - 8);
  });

  it("shortens to the larger side when it fits on neither", () => {
    const position = placeNoteTooltip(icon(100, 500), 1000, { width: 1024, height: 300 });
    expect(position.placement).toBe("below");
    expect(position.maxHeight).toBe(300 - 116 - 8 - 8);
    expect(position.top).toBe(124);
  });
});

describe("NoteIndicator popup after the note changes size", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("moves below the icon when an image in the note loads and it no longer fits above", () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(): void {
          observers.push(this.callback);
        }
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    // The icon sits 150px from the top of a 768px window: 134px of room above.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      { top: 150, bottom: 166, left: 500, right: 516, width: 16, height: 16, x: 500, y: 150, toJSON: () => ({}) } as DOMRect
    );
    let noteHeight = 100;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? noteHeight : 0;
    });

    render(<NoteIndicator notes="![receipt](receipt.png)" />);
    fireEvent.mouseEnter(screen.getByLabelText("Has notes").closest("span")!);
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-placement", "above");

    // The image loads: the note is now taller than the room above the icon.
    noteHeight = 180;
    act(() => {
      for (const callback of observers) callback([], {} as ResizeObserver);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-placement", "below");
    expect(tooltip.style.top).toBe(`${166 + 8}px`);
  });
});
