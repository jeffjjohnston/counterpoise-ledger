import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReportIssueModal } from "@/components/ReportIssueModal";

vi.mock("next/navigation", () => ({
  usePathname: () => "/b/1/transactions",
}));

describe("ReportIssueModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("renders form with type select and description textarea", () => {
    render(
      <ReportIssueModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
    );

    expect(screen.getByLabelText("Type")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByText("Submit")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("shows error when submitting empty description", async () => {
    render(
      <ReportIssueModal isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
    );

    fireEvent.click(screen.getByText("Submit"));
    expect(screen.getByText("Please describe the issue.")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits issue and calls onSuccess", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 })
    );
    const onSuccess = vi.fn();

    render(
      <ReportIssueModal isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />
    );

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Something is broken" },
    });
    fireEvent.click(screen.getByText("Submit"));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/issue-reports", expect.objectContaining({
      method: "POST",
    }));
  });

  it("calls onClose when cancel clicked", () => {
    const onClose = vi.fn();
    render(
      <ReportIssueModal isOpen={true} onClose={onClose} onSuccess={vi.fn()} />
    );

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders nothing when not open", () => {
    render(
      <ReportIssueModal isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />
    );

    expect(screen.queryByText("Report an Issue")).not.toBeInTheDocument();
  });
});
