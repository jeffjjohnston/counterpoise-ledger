import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { SAVE_CHORD_KEY } from "@/lib/save-chord";
import type { AccountWithBalance } from "@/types";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/transactions",
  })
);

const mockAccounts: AccountWithBalance[] = [
  {
    id: 1,
    bookId: 1,
    name: "Brokerage",
    type: "asset",
    subtype: "investment",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 2,
    bookId: 1,
    name: "Brokerage Cash",
    type: "asset",
    subtype: "cash",
    parentId: 1,
    isActive: true,
    isInvestmentCash: true,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 3,
    bookId: 1,
    name: "Checking",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 4,
    bookId: 1,
    name: "Groceries",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
  {
    id: 5,
    bookId: 1,
    name: "Savings",
    type: "asset",
    subtype: "bank",
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
    icon: null,
    isFavorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    balance: 0,
    hasTransactions: true,
  },
];

// Each started oscillator, as its frequency.
const played: number[] = [];

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }
  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: () => played.push(oscillator.frequency.value),
      stop: vi.fn(),
    };
    return oscillator;
  }
}

async function enterAndSave() {
  const toAccountInput = screen.getByLabelText("To Account");
  fireEvent.focus(toAccountInput);
  const groceries = await waitFor(() => {
    const button = screen.queryAllByRole("button").find((btn) => btn.textContent?.includes("Groceries"));
    expect(button).toBeInTheDocument();
    return button!;
  });
  fireEvent.click(groceries);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25.00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Add Transaction" }).closest("form")!);
}

describe("TransactionForm save chord", () => {
  beforeEach(() => {
    played.length = 0;
    localStorage.clear();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("plays a two-note chord after a successful save when the setting is on", async () => {
    localStorage.setItem(SAVE_CHORD_KEY, "true");
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
      </ToastProvider>
    );

    await enterAndSave();

    expect(onSubmit).toHaveBeenCalled();
    await waitFor(() => expect(played).toEqual([523.25, 783.99]));
  });

  it("does not play before the server confirms the save", async () => {
    localStorage.setItem(SAVE_CHORD_KEY, "true");
    let confirm: (ok: boolean) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => (confirm = resolve)));
    render(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
      </ToastProvider>
    );

    await enterAndSave();
    await Promise.resolve();
    expect(played).toEqual([]);

    confirm(true);
    await waitFor(() => expect(played).toHaveLength(2));
  });

  it("stays silent when the setting is off", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
      </ToastProvider>
    );

    await enterAndSave();

    expect(onSubmit).toHaveBeenCalled();
    await onSubmit.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(played).toEqual([]);
  });

  it("stays silent when the save fails", async () => {
    localStorage.setItem(SAVE_CHORD_KEY, "true");
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
      </ToastProvider>
    );

    await enterAndSave();

    expect(onSubmit).toHaveBeenCalled();
    await onSubmit.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(played).toEqual([]);
  });

  it("stays silent when the save handler reports nothing", async () => {
    localStorage.setItem(SAVE_CHORD_KEY, "true");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <TransactionForm accounts={mockAccounts} selectedAccountId={3} onSubmit={onSubmit} />
      </ToastProvider>
    );

    await enterAndSave();

    await onSubmit.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(played).toEqual([]);
  });
});
