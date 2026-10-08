import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DateInput } from "@/components/ui/DateInput";

describe("DateInput", () => {
  it("formats the incoming value as MM/DD/YYYY", () => {
    render(<DateInput id="date" label="Date" value="2025-01-15" onChange={vi.fn()} />);

    expect(screen.getByLabelText("Date")).toHaveValue("01/15/2025");
  });

  it("parses typed MM/DD/YYYY input into YYYY-MM-DD", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);

    const input = screen.getByPlaceholderText("MM/DD/YYYY");
    fireEvent.change(input, { target: { value: "02/20/2025" } });

    expect(handleChange).toHaveBeenCalledWith("2025-02-20");
  });

  it("resets invalid input on blur", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);

    const input = screen.getByPlaceholderText("MM/DD/YYYY");
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("01/15/2025");
  });

  it("selects a date from the calendar popover", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);

    const input = screen.getByPlaceholderText("MM/DD/YYYY");
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("gridcell", { name: "January 20, 2025" }));

    expect(handleChange).toHaveBeenCalledWith("2025-01-20");
  });
});

describe("DateInput keyboard navigation", () => {
  // Mirrors the real event order for a click that moves focus into the field:
  // mousedown lands while the field is still unfocused, so the click that
  // follows is the one that opens the calendar rather than placing a caret.
  function openForNavigation(input: HTMLInputElement) {
    fireEvent.mouseDown(input);
    act(() => input.focus());
    fireEvent.click(input);
  }

  it("moves the calendar highlight with arrow keys without committing a date", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).toHaveAttribute("data-highlighted", "true");
    expect(handleChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("01/15/2025");
  });

  it("commits the highlighted date on Enter", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(handleChange).toHaveBeenCalledWith("2025-01-22");
    expect(screen.queryByRole("gridcell", { name: "January 22, 2025" })).toBeNull();
  });

  it("leaves Enter to the surrounding form when the highlight has not moved", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });

    expect(handleChange).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("steps a whole month with Page Down, clamping to the shorter month", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-31" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.keyDown(input, { key: "PageDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(handleChange).toHaveBeenCalledWith("2025-02-28");
  });

  it("scrolls the calendar when the highlight crosses a month boundary", () => {
    render(<DateInput id="date" value="2025-01-01" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.keyDown(input, { key: "ArrowLeft" });

    expect(screen.getByText("December 2024")).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "December 31, 2024" })).toHaveAttribute("data-highlighted", "true");
  });

  it("hands the arrow keys back to the caret on a second click", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).not.toHaveAttribute("data-highlighted");
  });

  it("treats the first click after a tab focus as text entry", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    act(() => input.focus());
    expect(screen.getByRole("gridcell", { name: "January 15, 2025" })).toHaveAttribute("data-highlighted", "true");

    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).not.toHaveAttribute("data-highlighted");
  });

  it("hands the arrow keys back to the caret once the user types", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.change(input, { target: { value: "01/01/2025" } });
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).not.toHaveAttribute("data-highlighted");
  });

  it("re-enters calendar navigation from text entry with ArrowDown", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByRole("gridcell", { name: "January 15, 2025" })).toHaveAttribute("data-highlighted", "true");
    expect(handleChange).not.toHaveBeenCalled();
  });
});

describe("DateInput mouse reopening", () => {
  function openForNavigation(input: HTMLInputElement) {
    fireEvent.mouseDown(input);
    act(() => input.focus());
    fireEvent.click(input);
  }

  // selectDate closes the calendar and refocuses the field, so the field never
  // blurs and no further focus event can fire. Opening only from onFocus left
  // the mouse with no way back into the calendar at all.
  it("reopens the calendar when the field is clicked after a date was picked", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.click(screen.getByRole("gridcell", { name: "January 20, 2025" }));
    expect(screen.queryByRole("gridcell", { name: "January 20, 2025" })).toBeNull();

    fireEvent.mouseDown(input);
    fireEvent.click(input);

    expect(screen.getByRole("gridcell", { name: "January 20, 2025" })).toBeInTheDocument();
  });

  // Reopening must not take the arrow keys back: a click on an already-focused
  // field is asking for a caret, and that is what the arrows should move.
  it("leaves the arrow keys on the caret when a click reopens the calendar", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.click(screen.getByRole("gridcell", { name: "January 20, 2025" }));

    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).not.toHaveAttribute("data-highlighted");
  });
});

describe("DateInput assistive-tech semantics", () => {
  function openForNavigation(input: HTMLInputElement) {
    fireEvent.mouseDown(input);
    act(() => input.focus());
    fireEvent.click(input);
  }

  it("exposes the field as a collapsed combobox before the calendar opens", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-haspopup", "grid");
    // A collapsed combobox has no popup to point at, and a dangling id is
    // worse than no reference at all.
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("marks the calendar as an expanded grid the field controls", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);

    const grid = screen.getByRole("grid");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", grid.id);
    expect(grid).toHaveAccessibleName("January 2025");
  });

  it("names every day cell with its full date", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);

    expect(screen.getByRole("gridcell", { name: "January 15, 2025" })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "January 31, 2025" })).toBeInTheDocument();
  });

  it("points aria-activedescendant at the highlighted day and follows the arrow keys", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("gridcell", { name: "January 15, 2025" }).id
    );

    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("gridcell", { name: "January 16, 2025" }).id
    );
  });

  it("drops aria-activedescendant rather than dangling it into a month it left", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));

    // The highlight stayed on 15 January while the view moved to February, so
    // the cell it named is no longer rendered.
    expect(screen.getByRole("grid")).toHaveAccessibleName("February 2025");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("hands the arrow keys back to the caret without leaving an active descendant", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);

    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("marks the selected date and leaves the other days unselected", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);

    expect(screen.getByRole("gridcell", { name: "January 15, 2025" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("gridcell", { name: "January 16, 2025" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("lays the calendar out as named column headers over rows of seven cells", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);

    const grid = screen.getByRole("grid");
    const headers = within(grid).getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);

    // Every row is a full week, so the padding either side of the month is
    // made of real cells rather than gaps the grid cannot describe.
    const rows = within(grid).getAllByRole("row");
    const weekRows = rows.filter((row) => within(row).queryAllByRole("gridcell").length > 0);
    expect(weekRows.length).toBeGreaterThan(0);
    for (const row of weekRows) {
      expect(within(row).getAllByRole("gridcell")).toHaveLength(7);
    }
  });

  it("keeps the day cells out of the tab sequence", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByRole("combobox");

    openForNavigation(input);

    // The input holds focus and names the active day; a tab stop on each of
    // the month's days would contradict that.
    for (const cell of screen.getAllByRole("gridcell", { name: /2025/ })) {
      expect(cell).toHaveAttribute("tabindex", "-1");
    }
  });

  describe("calendar position", () => {
    const innerWidth = window.innerWidth;
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
    });

    /** Opens the calendar of a field whose left edge is at `left`, on a 390 px screen. */
    function openAt(left: number) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
        { left, right: left + 170, top: 0, bottom: 36, width: 170, height: 36, x: left, y: 0, toJSON: () => ({}) },
      );
      render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
      const input: HTMLInputElement = screen.getByRole("combobox");
      fireEvent.mouseDown(input);
      act(() => input.focus());
      fireEvent.click(input);
      return screen.getByRole("grid").closest("[data-align]");
    }

    it("opens at the left edge of the field when the calendar fits", () => {
      expect(openAt(16)).toHaveAttribute("data-align", "left");
    });

    it("opens at the right edge of the field when the calendar would go past the screen", () => {
      // 201 + 272 (17rem) is past 390.
      expect(openAt(201)).toHaveAttribute("data-align", "right");
    });
  });
});
