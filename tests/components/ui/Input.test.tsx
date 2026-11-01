import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Input } from "@/components/ui/Input";

describe("Input", () => {
  it("gives the input its label as the accessible name", () => {
    render(<Input id="test-input" label="Test Label" />);
    expect(screen.getByRole("textbox", { name: "Test Label" })).toHaveAttribute("id", "test-input");
  });

  it("keeps the accessible name when the label is hidden, and adds the suffix to it", () => {
    render(
      <>
        <Input id="hidden" label="Amount" labelHidden />
        <Input id="suffixed" label="Memo" labelSuffix="optional" />
      </>
    );
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveAttribute("id", "hidden");
    // jsdom's name calculation drops the space before the dash. A browser keeps it.
    expect(screen.getByRole("textbox", { name: /^Memo\s*— optional$/ })).toHaveAttribute("id", "suffixed");
  });

  it("sends value changes to the onChange handler", () => {
    const handleChange = vi.fn();
    render(<Input id="test" label="Name" onChange={handleChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "test" } });
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange.mock.calls[0][0].target.value).toBe("test");
  });

  it("displays error message when provided", () => {
    render(<Input id="test" error="This field is required" />);
    expect(screen.getByText("This field is required")).toBeInTheDocument();
  });

  it("applies error styles when error is provided", () => {
    render(<Input id="test" error="Error" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveClass(
      "border-border-danger",
      "focus:border-border-danger",
      "focus:ring-border-danger"
    );
  });

  it("accepts placeholder text", () => {
    render(<Input id="test" placeholder="Enter value" />);
    const input = screen.getByPlaceholderText("Enter value");
    expect(input).toBeInTheDocument();
  });

  it("supports required attribute", () => {
    render(<Input id="test" required />);
    const input = screen.getByRole("textbox");
    expect(input).toBeRequired();
  });

  it("supports disabled attribute", () => {
    render(<Input id="test" disabled />);
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });

  it("lets a caller class replace a conflicting default class", () => {
    render(<Input id="test" className="custom-class px-1" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveClass("custom-class", "px-1");
    expect(input).not.toHaveClass("px-3");
  });

  it("supports different input types", () => {
    render(<Input id="test" type="date" />);
    const input = document.querySelector('input[type="date"]');
    expect(input).toBeInTheDocument();
  });

  it("selects all text on focus when selectOnFocus is set", () => {
    render(<Input id="test" selectOnFocus defaultValue="123.45" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.focus(input);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("123.45".length);
  });

  it("does not select text on focus by default", () => {
    render(<Input id="test" defaultValue="123.45" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    input.setSelectionRange(0, 0);

    fireEvent.focus(input);

    expect(input.selectionEnd).toBe(0);
  });

  it("still calls a provided onFocus handler when selectOnFocus is set", () => {
    const handleFocus = vi.fn();
    render(<Input id="test" selectOnFocus defaultValue="42" onFocus={handleFocus} />);

    fireEvent.focus(screen.getByRole("textbox"));

    expect(handleFocus).toHaveBeenCalled();
  });

  it("does not break focus handling when select() is unsupported for the input type", () => {
    const handleFocus = vi.fn();
    render(<Input id="test" type="number" selectOnFocus defaultValue="42" onFocus={handleFocus} />);

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    vi.spyOn(input, "select").mockImplementation(() => {
      throw new DOMException("not supported", "InvalidStateError");
    });

    expect(() => fireEvent.focus(input)).not.toThrow();
    expect(handleFocus).toHaveBeenCalled();
  });
});
