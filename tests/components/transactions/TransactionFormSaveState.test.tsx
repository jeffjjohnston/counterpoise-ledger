// The form keeps the entry until the save handler reports the result, and
// sends one save at a time. A failed create must not lose what the user
// typed, and a second submit during the request must not send a second
// write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { AccountWithBalance, TransactionWithSplits } from "@/types";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/transactions",
  })
);

const account = (id: number, name: string, type: string, subtype: string | null) =>
  ({
    id, bookId: 1, name, type, subtype, parentId: null, isActive: true, isInvestmentCash: false, icon: null,
    isFavorite: false, createdAt: new Date(), updatedAt: new Date(), balance: 0, hasTransactions: true,
  }) as AccountWithBalance;

const accounts = [account(3, "Checking", "asset", "bank"), account(4, "Groceries", "expense", null)];

type SaveResult = void | boolean | number;

/** A save handler whose answer the test gives later. */
function deferredSave() {
  const answers: Array<{ resolve: (value: SaveResult) => void; reject: (error: Error) => void }> = [];
  const onSubmit = vi.fn(
    () => new Promise<SaveResult>((resolve, reject) => answers.push({ resolve, reject }))
  );
  return { onSubmit, answers };
}

function renderForm(props: Partial<React.ComponentProps<typeof TransactionForm>>) {
  return render(
    <ToastProvider>
      <TransactionForm accounts={accounts} selectedAccountId={3} onSubmit={vi.fn()} {...props} />
    </ToastProvider>
  );
}

const form = () => screen.getByLabelText("Amount").closest("form")!;

async function typeEntry() {
  fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Corner Shop" } });
  fireEvent.focus(screen.getByLabelText("To Account"));
  const groceries = await waitFor(() => {
    const button = screen.queryAllByRole("button").find((btn) => btn.textContent?.includes("Groceries"));
    expect(button).toBeInTheDocument();
    return button!;
  });
  fireEvent.click(groceries);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25.00" } });
}

function expectEntryKept() {
  expect(screen.getByLabelText("Payee")).toHaveValue("Corner Shop");
  expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
  expect(screen.getByLabelText("Amount")).toHaveValue("25.00");
}

function expectEntryCleared() {
  expect(screen.getByLabelText("Payee")).toHaveValue("");
  expect(screen.getByLabelText("To Account")).toHaveValue("");
  expect(screen.getByLabelText("Amount")).toHaveValue("");
}

/**
 * Types as a user can: a disabled field takes no input. jsdom would change
 * the value of a disabled field, so the helper checks first. It returns
 * true when the field took the text.
 */
function typeAsUser(field: HTMLElement, value: string) {
  if (field.matches(":disabled")) return false;
  fireEvent.change(field, { target: { value } });
  return true;
}

/** A browser takes the focus away from a field that becomes disabled. jsdom does not. */
function dropFocusFromDisabledField() {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused?.matches(":disabled")) return;
  // jsdom does not blur a disabled element. The focus moves to a temporary
  // field, and the removal of that field leaves the focus on the body.
  const temporary = document.createElement("input");
  document.body.append(temporary);
  temporary.focus();
  temporary.remove();
}

describe("TransactionForm save state", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the entry while the save is in flight, and clears it after the save succeeds", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expectEntryKept();

    await act(async () => answers[0].resolve(41));
    expectEntryCleared();
  });

  it("keeps the entry when the save handler reports a failure", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());
    await act(async () => answers[0].resolve(false));

    expectEntryKept();
    // The user can send the same entry again.
    expect(screen.getByRole("button", { name: "Add Transaction" })).toBeEnabled();
    fireEvent.submit(form());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the entry when the save handler rejects", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());
    await act(async () => answers[0].reject(new Error("network")));

    expectEntryKept();
    expect(screen.getByRole("button", { name: "Add Transaction" })).toBeEnabled();
  });

  it("clears the entry after a handler that returns no value", async () => {
    // A handler without a result reports no failure.
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());

    await waitFor(expectEntryCleared);
  });

  it("sends one save when the user submits again during the request", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());
    expect(screen.getByRole("button", { name: "Add Transaction" })).toBeDisabled();
    fireEvent.submit(form());
    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => answers[0].resolve(41));
    expect(screen.getByRole("button", { name: "Add Transaction" })).toBeEnabled();
  });

  it("takes no input during the save, so the save erases nothing that the user typed", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();

    fireEvent.submit(form());
    // The user starts the next entry before the answer.
    const accepted = typeAsUser(screen.getByLabelText("Payee"), "Next Shop");
    const lockedDuringSave = ["Amount", "To Account", "From Account", "Date"].map((label) =>
      screen.getByLabelText(label).matches(":disabled")
    );
    const tabLockedDuringSave = screen.getByRole("button", { name: "Journal" }).matches(":disabled");

    await act(async () => answers[0].resolve(41));

    // The form must refuse the text. It must not accept the text and then
    // erase it with the saved entry.
    expect(screen.getByLabelText("Payee")).toHaveValue("");
    expect(accepted).toBe(false);
    expect(lockedDuringSave).toEqual([true, true, true, true]);
    expect(tabLockedDuringSave).toBe(true);
    expect(screen.getByLabelText("Payee")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Journal" })).toBeEnabled();
  });

  it("takes no input in the split rows during the save", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit, fullLayout: true });
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    // Two rows with a zero amount balance, so the form sends them.
    fireEvent.submit(screen.getByRole("button", { name: /Add Transaction/ }).closest("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    for (const field of screen.getAllByRole("textbox")) expect(field).toBeDisabled();
    expect(screen.getByRole("button", { name: "Simple" })).toBeDisabled();

    await act(async () => answers[0].resolve(false));
    for (const field of screen.getAllByRole("textbox")) expect(field).toBeEnabled();
  });

  it("returns the focus to the field that had it when the save fails", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();
    const amount = screen.getByLabelText("Amount");
    amount.focus();

    fireEvent.keyDown(amount, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    dropFocusFromDisabledField();
    expect(amount).not.toHaveFocus();

    await act(async () => answers[0].resolve(false));

    expect(amount).toHaveFocus();
    expectEntryKept();
  });

  it("moves the focus to Payee for the next entry when the save succeeds", async () => {
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit });
    await typeEntry();
    const amount = screen.getByLabelText("Amount");
    amount.focus();

    fireEvent.keyDown(amount, { key: "Enter", ctrlKey: true });
    dropFocusFromDisabledField();

    await act(async () => answers[0].resolve(41));

    await waitFor(() => expect(screen.getByLabelText("Payee")).toHaveFocus());
    expectEntryCleared();
  });

  it("sends one update when Ctrl+Enter is pressed twice in the edit form", async () => {
    const editing = {
      id: 8, bookId: 1, date: "2024-06-01", description: "Coffee", checkNumber: null, notes: null,
      payeeId: null, isReconciled: false, isFloating: false, recurringRuleId: null, createdBy: null,
      updatedBy: null, createdAt: new Date("2024-06-01T00:00:00.000Z"), updatedAt: new Date("2024-06-01T00:00:00.000Z"),
      payee: null, investmentSplits: [],
      splits: [
        { id: 1, transactionId: 8, accountId: 4, amount: 2500, account: accounts[1] },
        { id: 2, transactionId: 8, accountId: 3, amount: -2500, account: accounts[0] },
      ],
    } as unknown as TransactionWithSplits;
    const { onSubmit, answers } = deferredSave();
    renderForm({ onSubmit, editingTransaction: editing, onCancel: vi.fn() });
    await waitFor(() => expect(screen.getByLabelText("Amount")).toHaveValue("25.00"));

    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Enter", ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    await act(async () => answers[0].resolve(false));
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("creates one expense account when Enter is pressed twice", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if ((init?.method ?? "GET").toUpperCase() === "POST" && url === "/api/b/1/accounts") {
          posts.push(String(init?.body));
          // The request stays in flight.
          return new Promise(() => {});
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );
    renderForm({ fullLayout: true });

    fireEvent.click(screen.getByRole("button", { name: "+ New Expense Account" }));
    const name = screen.getByLabelText("New Expense Name");
    fireEvent.change(name, { target: { value: "Coffee" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled());
    expect(posts).toHaveLength(1);
  });
});
