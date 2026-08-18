import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";

const payees = [
  { id: 1, name: "Whole Foods" },
  { id: 2, name: "Walmart" },
  { id: 3, name: "Target" },
  { id: 4, name: "Costco" },
];

describe("PayeeAutocomplete (ID mode)", () => {
  it("renders with placeholder", () => {
    render(
      <PayeeAutocomplete payees={payees} value={null} onChange={vi.fn()} />
    );
    expect(screen.getByPlaceholderText("Search for a payee...")).toBeInTheDocument();
  });

  it("shows selected payee name in input", () => {
    render(
      <PayeeAutocomplete payees={payees} value={1} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Whole Foods");
  });

  it("filters payees based on search term", () => {
    render(
      <PayeeAutocomplete payees={payees} value={null} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "wal" } });

    expect(screen.getByText("Walmart")).toBeInTheDocument();
    expect(screen.queryByText("Target")).not.toBeInTheDocument();
  });

  it("calls onChange with payee id when selected", () => {
    const onChange = vi.fn();
    render(
      <PayeeAutocomplete payees={payees} value={null} onChange={onChange} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Tar" } });
    fireEvent.click(screen.getByText("Target"));

    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("renders label when provided", () => {
    render(
      <PayeeAutocomplete payees={payees} value={null} onChange={vi.fn()} label="Payee" />
    );
    expect(screen.getByText("Payee")).toBeInTheDocument();
  });

  it("navigates with keyboard", () => {
    const onChange = vi.fn();
    render(
      <PayeeAutocomplete payees={payees} value={null} onChange={onChange} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    // dropdown is now open (focus triggers setIsOpen(true))
    // ArrowDown: dropdown is open, move highlight from 0 to 1
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // ArrowDown again: move from 1 to 2
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalled();
  });
});

describe("PayeeAutocomplete (text mode)", () => {
  it("uses textValue as input value", () => {
    render(
      <PayeeAutocomplete
        payees={payees}
        textValue="Whole"
        onTextChange={vi.fn()}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Whole");
  });

  it("calls onTextChange on input change", () => {
    const onTextChange = vi.fn();
    render(
      <PayeeAutocomplete
        payees={payees}
        textValue=""
        onTextChange={onTextChange}
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Payee" } });
    expect(onTextChange).toHaveBeenCalledWith("New Payee");
  });

  it("calls onTextChange with payee name when item selected", () => {
    const onTextChange = vi.fn();
    render(
      <PayeeAutocomplete
        payees={payees}
        textValue="Tar"
        onTextChange={onTextChange}
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.click(screen.getByText("Target"));
    expect(onTextChange).toHaveBeenCalledWith("Target");
  });
});
