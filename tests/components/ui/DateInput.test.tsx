import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "20" }));

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

    expect(screen.getByRole("button", { name: "16" })).toHaveAttribute("data-highlighted", "true");
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
    expect(screen.queryByRole("button", { name: "22" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "31" })).toHaveAttribute("data-highlighted", "true");
  });

  it("hands the arrow keys back to the caret on a second click", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("button", { name: "16" })).not.toHaveAttribute("data-highlighted");
  });

  it("treats the first click after a tab focus as text entry", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    act(() => input.focus());
    expect(screen.getByRole("button", { name: "15" })).toHaveAttribute("data-highlighted", "true");

    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("button", { name: "16" })).not.toHaveAttribute("data-highlighted");
  });

  it("hands the arrow keys back to the caret once the user types", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.change(input, { target: { value: "01/01/2025" } });
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("button", { name: "16" })).not.toHaveAttribute("data-highlighted");
  });

  it("re-enters calendar navigation from text entry with ArrowDown", () => {
    const handleChange = vi.fn();
    render(<DateInput id="date" value="2025-01-15" onChange={handleChange} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByRole("button", { name: "15" })).toHaveAttribute("data-highlighted", "true");
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
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    expect(screen.queryByRole("button", { name: "20" })).toBeNull();

    fireEvent.mouseDown(input);
    fireEvent.click(input);

    expect(screen.getByRole("button", { name: "20" })).toBeInTheDocument();
  });

  // Reopening must not take the arrow keys back: a click on an already-focused
  // field is asking for a caret, and that is what the arrows should move.
  it("leaves the arrow keys on the caret when a click reopens the calendar", () => {
    render(<DateInput id="date" value="2025-01-15" onChange={vi.fn()} />);
    const input: HTMLInputElement = screen.getByPlaceholderText("MM/DD/YYYY");

    openForNavigation(input);
    fireEvent.click(screen.getByRole("button", { name: "20" }));

    fireEvent.mouseDown(input);
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(screen.getByRole("button", { name: "16" })).not.toHaveAttribute("data-highlighted");
  });
});
