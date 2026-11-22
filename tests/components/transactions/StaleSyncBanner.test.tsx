import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleSyncBanner } from "@/components/transactions/StaleSyncBanner";

vi.mock("@/lib/navigation", async () => (await import("@/tests/helpers/navigation")).mockNavigation());

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body }) as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StaleSyncBanner", () => {
  it("lists each linked transaction whose amount is different from the bank", async () => {
    stub({
      totalCount: 0,
      accounts: [],
      mismatchedLinks: [{ transactionId: 12, accountId: 3, bankAmount: -450, linkedAmount: -453 }],
    });
    render(<StaleSyncBanner bookId="1" />);
    expect(await screen.findByText(/1 linked transaction has a different amount from the bank/)).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/b/1/transactions?accountId=3&highlight=12");
    expect(link.textContent).toContain("→");
  });

  it("shows nothing when there is nothing to report", async () => {
    stub({ totalCount: 0, accounts: [], mismatchedLinks: [] });
    const { container } = render(<StaleSyncBanner bookId="1" />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
