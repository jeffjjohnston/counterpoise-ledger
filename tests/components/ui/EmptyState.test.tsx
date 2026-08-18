import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "@/components/ui/EmptyState";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="Nothing here yet" />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("renders optional description", () => {
    render(<EmptyState title="Empty" description="Try adjusting your filters." />);
    expect(screen.getByText("Try adjusting your filters.")).toBeInTheDocument();
  });

  it("renders a button action and calls onClick", () => {
    const handleClick = vi.fn();
    render(
      <EmptyState
        title="Empty"
        action={{ label: "Add one", onClick: handleClick }}
      />
    );
    fireEvent.click(screen.getByText("Add one"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("renders a link action when href is provided", () => {
    render(
      <EmptyState
        title="Empty"
        action={{ label: "Go somewhere", href: "/somewhere" }}
      />
    );
    const link = screen.getByRole("link", { name: "Go somewhere" });
    expect(link).toHaveAttribute("href", "/somewhere");
  });

  it("renders no action when action prop is omitted", () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("applies custom className to root div", () => {
    render(<EmptyState title="Empty" className="custom-cls" data-testid="es" />);
    expect(screen.getByTestId("es")).toHaveClass("custom-cls");
  });
});
