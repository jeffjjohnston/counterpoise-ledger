import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TransactionAuthorship } from "@/components/transactions/TransactionAuthorship";
import { useBookRole } from "@/components/BookRoleProvider";

vi.mock("@/components/BookRoleProvider", () => ({ useBookRole: vi.fn() }));

const withMembers = (members: Array<{ userId: number; username: string }>) =>
  vi.mocked(useBookRole).mockReturnValue({ members } as unknown as ReturnType<typeof useBookRole>);

describe("TransactionAuthorship", () => {
  it("shows nothing in a book with one member", () => {
    withMembers([{ userId: 1, username: "solo" }]);
    const { container } = render(<TransactionAuthorship createdBy={1} updatedBy={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the creator and the last editor", () => {
    withMembers([{ userId: 1, username: "alice" }, { userId: 2, username: "bob" }]);
    render(<TransactionAuthorship createdBy={1} updatedBy={2} />);
    expect(screen.getByText("Added by alice · Last changed by bob")).toBeInTheDocument();
  });

  it("names System for null and Former member for an unknown id", () => {
    withMembers([{ userId: 1, username: "alice" }, { userId: 2, username: "bob" }]);
    render(<TransactionAuthorship createdBy={null} updatedBy={99} />);
    expect(screen.getByText("Added by System · Last changed by Former member")).toBeInTheDocument();
  });
});
