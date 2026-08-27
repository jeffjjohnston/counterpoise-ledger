import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";

describe("Modal", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    title: "Test Modal",
    children: <p>Modal content</p>,
  };

  it("renders title and children when open", () => {
    render(<Modal {...defaultProps} />);
    expect(screen.getByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<Modal {...defaultProps} isOpen={false} />);
    expect(screen.queryByText("Test Modal")).not.toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<Modal {...defaultProps} onClose={onClose} />);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(<Modal {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<Modal {...defaultProps} onClose={onClose} />);
    const overlay = container.firstChild as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when modal content is clicked", () => {
    const onClose = vi.fn();
    render(<Modal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Modal content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  // PlaidBanner renders a ConfirmModal inside TransactionForm, which the
  // transactions page renders inside a Modal. Before this, one Escape closed
  // both — discarding the edit in progress — and closing the confirmation
  // unlocked page scroll behind the editor that was still open.
  describe("nested modals", () => {
    function Nested({
      innerOpen,
      onOuterClose,
      onInnerClose,
    }: {
      innerOpen: boolean;
      onOuterClose: () => void;
      onInnerClose: () => void;
    }) {
      return (
        <Modal isOpen onClose={onOuterClose} title="Edit transaction">
          <p>Outer content</p>
          <Modal isOpen={innerOpen} onClose={onInnerClose} title="Unlink from Plaid?">
            <p>Inner content</p>
          </Modal>
        </Modal>
      );
    }

    it("closes only the topmost modal on Escape", () => {
      const onOuterClose = vi.fn();
      const onInnerClose = vi.fn();

      render(
        <Nested innerOpen onOuterClose={onOuterClose} onInnerClose={onInnerClose} />
      );

      fireEvent.keyDown(document, { key: "Escape" });

      expect(onInnerClose).toHaveBeenCalledOnce();
      expect(onOuterClose).not.toHaveBeenCalled();
    });

    it("hands Escape back to the outer modal once the inner one closes", () => {
      const onOuterClose = vi.fn();
      const onInnerClose = vi.fn();

      const { rerender } = render(
        <Nested innerOpen onOuterClose={onOuterClose} onInnerClose={onInnerClose} />
      );

      rerender(
        <Nested
          innerOpen={false}
          onOuterClose={onOuterClose}
          onInnerClose={onInnerClose}
        />
      );

      fireEvent.keyDown(document, { key: "Escape" });

      expect(onOuterClose).toHaveBeenCalledOnce();
      expect(onInnerClose).not.toHaveBeenCalled();
    });

    it("keeps page scroll locked while the outer modal is still open", () => {
      // Stable callbacks on purpose: a fresh onClose per render would re-run
      // the outer modal's effect and re-lock scroll by accident, hiding the
      // very thing this asserts.
      const onOuterClose = vi.fn();
      const onInnerClose = vi.fn();

      const { rerender } = render(
        <Nested innerOpen onOuterClose={onOuterClose} onInnerClose={onInnerClose} />
      );

      expect(document.body.style.overflow).toBe("hidden");

      rerender(
        <Nested
          innerOpen={false}
          onOuterClose={onOuterClose}
          onInnerClose={onInnerClose}
        />
      );

      expect(document.body.style.overflow).toBe("hidden");
    });

    it("unlocks page scroll once the last modal closes", () => {
      const { unmount } = render(<Modal {...defaultProps} />);
      expect(document.body.style.overflow).toBe("hidden");

      unmount();
      expect(document.body.style.overflow).toBe("");
    });
  });

  it("applies size classes", () => {
    const { container } = render(<Modal {...defaultProps} size="xl" />);
    const modalBox = container.querySelector(".sm\\:max-w-5xl");
    expect(modalBox).toBeInTheDocument();
  });

  it("defaults to md size", () => {
    const { container } = render(<Modal {...defaultProps} />);
    const modalBox = container.querySelector(".sm\\:max-w-lg");
    expect(modalBox).toBeInTheDocument();
  });
});
