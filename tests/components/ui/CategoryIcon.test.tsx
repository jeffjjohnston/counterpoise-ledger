import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryIcon } from "@/components/ui/CategoryIcon";

describe("CategoryIcon", () => {
  it("renders the glyph when icon is a string", () => {
    render(<CategoryIcon icon="🚗" />);
    const icon = screen.getByText("🚗");
    expect(icon.tagName).toBe("SPAN");
  });

  it("renders nothing when icon is null", () => {
    const { container } = render(<CategoryIcon icon={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("applies aria-hidden to the rendered glyph", () => {
    render(<CategoryIcon icon="🚗" />);
    const icon = screen.getByText("🚗");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
