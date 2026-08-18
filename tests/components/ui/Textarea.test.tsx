import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Textarea } from "@/components/ui/Textarea";

describe("Textarea", () => {
  it("renders a labeled textarea", () => {
    render(<Textarea id="notes" label="Notes" />);

    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
  });

  it("handles value changes", () => {
    const handleChange = vi.fn();
    render(<Textarea id="notes" onChange={handleChange} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Updated notes" },
    });

    expect(handleChange).toHaveBeenCalled();
  });

  it("renders compact label styling", () => {
    render(<Textarea id="notes" label="Notes" size="compact" />);

    expect(screen.getByText("Notes")).toHaveClass("text-xs");
  });

  it("renders an error message and error styles", () => {
    render(<Textarea id="notes" error="Required" />);

    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveClass("border-border-danger");
  });
});
