import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "@/components/ui/Select";

const options = [
  { value: "asset", label: "Asset" },
  { value: "expense", label: "Expense" },
];

describe("Select", () => {
  it("renders a labeled select input", () => {
    render(<Select id="account-type" label="Account Type" options={options} />);

    expect(screen.getByLabelText("Account Type")).toBeInTheDocument();
  });

  it("renders a placeholder option when provided", () => {
    render(
      <Select
        id="account-type"
        options={options}
        placeholder="Choose account type"
        defaultValue=""
      />
    );

    expect(screen.getByRole("option", { name: "Choose account type" })).toBeDisabled();
  });

  it("handles value changes", () => {
    const handleChange = vi.fn();
    render(
      <Select
        id="account-type"
        options={options}
        onChange={handleChange}
        value="asset"
      />
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "expense" },
    });

    expect(handleChange).toHaveBeenCalled();
  });

  it("renders an error message and error styles", () => {
    render(<Select id="account-type" options={options} error="Required" />);

    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveClass("border-border-danger");
  });
});
