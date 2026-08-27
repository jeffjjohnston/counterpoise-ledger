import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmModal } from "@/components/ui/ConfirmModal";

const base = {
  title: "Reset sync?",
  body: <p>Everything staged is discarded.</p>,
  confirmLabel: "Reset sync",
};

describe("ConfirmModal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing when closed", () => {
    render(<ConfirmModal {...base} isOpen={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText("Reset sync?")).toBeNull();
  });

  it("shows the title, body and labelled confirm when open", () => {
    render(<ConfirmModal {...base} isOpen onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Reset sync?")).toBeInTheDocument();
    expect(screen.getByText("Everything staged is discarded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset sync" })).toBeInTheDocument();
  });

  it("calls onConfirm once when confirmed", () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...base} isOpen onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset sync" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when cancelled, without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmModal {...base} isOpen onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables confirm while busy, so a double-click cannot fire two deletes", () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...base} isOpen busy onConfirm={onConfirm} onClose={vi.fn()} />);
    const confirm = screen.getByRole("button", { name: /Reset sync/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
