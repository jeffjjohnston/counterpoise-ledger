import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlaidBanner } from "@/components/transactions/PlaidBanner";
import type { PlaidLinkData } from "@/types";

const mockPlaidData: PlaidLinkData = {
  id: 1,
  plaidTransactionId: "plaid-txn-abc123",
  date: "2025-06-01",
  authorizedDate: "2025-05-31",
  amountCents: -4500,
  name: "VENMO PAYMENT",
  merchantName: "Venmo",
  originalDescription: "VENMO PAYMENT 1234567890 WEB ID: 9876543210",
  pending: false,
  isoCurrencyCode: "USD",
  categoryPrimary: "TRANSFER",
  categoryDetailed: "TRANSFER_DEBIT",
  rawJson: '{"transaction_id":"plaid-txn-abc123","amount":45.00}',
};

describe("PlaidBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders collapsed state with name and amount", () => {
    render(
      <PlaidBanner
        plaidData={mockPlaidData}
        bookId="1"
        transactionId={10}
        onUnlinked={vi.fn()}
      />
    );

    expect(screen.getByText("Linked to Plaid")).toBeInTheDocument();
    expect(screen.getByText(/VENMO PAYMENT/)).toBeInTheDocument();
    expect(screen.getByText(/\$45\.00/)).toBeInTheDocument();
    // Detail fields should not be visible yet
    expect(screen.queryByText("Venmo")).not.toBeInTheDocument();
  });

  it("expands to show detail fields when Details is clicked", () => {
    render(
      <PlaidBanner
        plaidData={mockPlaidData}
        bookId="1"
        transactionId={10}
        onUnlinked={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText(/Details/));

    expect(screen.getByText("Venmo")).toBeInTheDocument();
    expect(screen.getByText("2025-06-01")).toBeInTheDocument();
    expect(screen.getByText("2025-05-31")).toBeInTheDocument();
    expect(screen.getByText("Posted")).toBeInTheDocument();
    expect(screen.getByText(/TRANSFER.*TRANSFER_DEBIT/)).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText(/VENMO PAYMENT 1234567890/)).toBeInTheDocument();
  });

  it("shows raw JSON when toggle is clicked", () => {
    render(
      <PlaidBanner
        plaidData={mockPlaidData}
        bookId="1"
        transactionId={10}
        onUnlinked={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText(/Details/));
    fireEvent.click(screen.getByText("View Raw JSON"));

    expect(screen.getByText(/transaction_id/)).toBeInTheDocument();
  });

  it("calls onUnlinked after confirming unlink", async () => {
    const onUnlinked = vi.fn();
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) } as Response);

    render(
      <PlaidBanner
        plaidData={mockPlaidData}
        bookId="1"
        transactionId={10}
        onUnlinked={onUnlinked}
      />
    );

    fireEvent.click(screen.getByText(/Details/));
    fireEvent.click(screen.getByText("Unlink from Plaid"));

    expect(globalThis.confirm).toHaveBeenCalledWith(
      "Unlink this transaction from Plaid? It will appear as an unmatched Plaid transaction in the Sync page."
    );

    await waitFor(() => {
      expect(onUnlinked).toHaveBeenCalled();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/b/1/transactions/10/plaid/unlink",
      { method: "POST" }
    );
  });

  it("does not call onUnlinked when confirm is cancelled", () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(
      <PlaidBanner
        plaidData={mockPlaidData}
        bookId="1"
        transactionId={10}
        onUnlinked={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText(/Details/));
    fireEvent.click(screen.getByText("Unlink from Plaid"));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits null fields from the detail view", () => {
    const sparseData: PlaidLinkData = {
      ...mockPlaidData,
      merchantName: null,
      authorizedDate: null,
      originalDescription: null,
      categoryPrimary: null,
      categoryDetailed: null,
      isoCurrencyCode: null,
    };

    render(
      <PlaidBanner
        plaidData={sparseData}
        bookId="1"
        transactionId={10}
        onUnlinked={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText(/Details/));

    expect(screen.queryByText("Merchant")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized Date")).not.toBeInTheDocument();
    expect(screen.queryByText("Original Description")).not.toBeInTheDocument();
    expect(screen.queryByText("Category")).not.toBeInTheDocument();
    expect(screen.queryByText("Currency")).not.toBeInTheDocument();
  });
});
