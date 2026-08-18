import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
