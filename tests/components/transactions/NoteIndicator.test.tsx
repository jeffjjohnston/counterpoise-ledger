import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { NoteIndicator } from "@/components/transactions/NoteIndicator";

describe("NoteIndicator", () => {
  it("renders the note icon", () => {
    render(<NoteIndicator notes="A note" />);
    expect(screen.getByLabelText("Has notes")).toBeInTheDocument();
  });

  it("shows tooltip on hover", () => {
    render(<NoteIndicator notes="Hello world" />);

    const icon = screen.getByLabelText("Has notes");
    fireEvent.mouseEnter(icon.closest("span")!);

    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("hides tooltip on mouse leave", () => {
    render(<NoteIndicator notes="Hello world" />);

    const wrapper = screen.getByLabelText("Has notes").closest("span")!;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByText("Hello world")).toBeInTheDocument();

    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByText("Hello world")).not.toBeInTheDocument();
  });
});
