import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card body</Card>);
    expect(screen.getByText("Card body")).toBeInTheDocument();
  });

  it("applies default styles", () => {
    const { container } = render(<Card>Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("bg-surface");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("border");
  });

  it("merges custom className", () => {
    const { container } = render(<Card className="mt-4">Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("mt-4");
    expect(card.className).toContain("bg-surface");
  });

  it("passes through HTML attributes", () => {
    render(<Card data-testid="my-card">Content</Card>);
    expect(screen.getByTestId("my-card")).toBeInTheDocument();
  });
});

describe("CardHeader", () => {
  it("renders with border-b styling", () => {
    const { container } = render(<CardHeader>Header</CardHeader>);
    const header = container.firstChild as HTMLElement;
    expect(header.className).toContain("border-b");
    expect(screen.getByText("Header")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    const { container } = render(<CardHeader className="py-8">Header</CardHeader>);
    const header = container.firstChild as HTMLElement;
    expect(header.className).toContain("py-8");
  });
});

describe("CardTitle", () => {
  it("renders as h3 with text styling", () => {
    render(<CardTitle>My Title</CardTitle>);
    const title = screen.getByText("My Title");
    expect(title.tagName).toBe("H3");
    expect(title.className).toContain("font-semibold");
  });
});

describe("CardContent", () => {
  it("renders children with padding", () => {
    const { container } = render(<CardContent>Body</CardContent>);
    const content = container.firstChild as HTMLElement;
    expect(content.className).toContain("p-6");
    expect(screen.getByText("Body")).toBeInTheDocument();
  });
});
