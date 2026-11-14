import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RecurringForm } from "@/components/recurring/RecurringForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance } from "@/types";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
  })
);

const account = (id: number, name: string, type: string, subtype: string | null) =>
  ({
    id, bookId: 1, name, type, subtype, parentId: null, isActive: true, isInvestmentCash: false, icon: null,
    isFavorite: false, createdAt: new Date(), updatedAt: new Date(), balance: 0, hasTransactions: true,
  }) as AccountWithBalance;

const accounts = [account(3, "Checking", "asset", "bank"), account(4, "Rent", "expense", null)];

describe("RecurringForm submit guard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends one submit when the user submits again during the save", async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(
      <ToastProvider>
        <RecurringForm
          accounts={accounts}
          bookId="1"
          prefill={{
            name: "Monthly Rent",
            templateDescription: "Rent",
            templateSplits: [{ accountId: 4, amount: 120000 }, { accountId: 3, amount: -120000 }],
          }}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </ToastProvider>
    );
    const button = screen.getByRole("button", { name: "Create Rule" });
    const form = button.closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    // The fields take no input during the save. A success closes the form,
    // and text typed during the save would be lost.
    expect(screen.getByLabelText("Rule Name")).toBeDisabled();

    // A failed save leaves the form open, so the button must work again.
    await act(async () => finish());
    expect(button).toBeEnabled();
    expect(screen.getByLabelText("Rule Name")).toBeEnabled();
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
