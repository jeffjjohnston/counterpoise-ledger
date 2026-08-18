import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton } from "@/components/ui/Skeleton";

describe("Skeleton", () => {
  it("renders an animate-pulse element", () => {
    render(<Skeleton data-testid="sk" />);
    expect(screen.getByTestId("sk")).toHaveClass("animate-pulse");
  });

  it("merges custom className", () => {
    render(<Skeleton data-testid="sk" className="h-4 w-32" />);
    const el = screen.getByTestId("sk");
    expect(el).toHaveClass("h-4", "w-32");
    expect(el).toHaveClass("animate-pulse");
  });
});
