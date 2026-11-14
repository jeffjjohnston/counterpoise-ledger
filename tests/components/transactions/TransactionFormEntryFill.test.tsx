import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { notifyTypeSafeSettings } from "@/lib/typesafe/events";
import { PAYEE_SEARCH_DELAY_MS, TransactionForm } from "@/components/transactions/TransactionForm";
import { SUGGESTION_DELAY_MS } from "@/hooks/useEntrySuggestion";
import { ToastProvider } from "@/components/ui/ToastProvider";
import type { EntryPattern } from "@/lib/typesafe/types";
import type { AccountWithBalance } from "@/types";

vi.mock("@/lib/navigation", async () =>
  (await import("@/tests/helpers/navigation")).mockNavigation({
    useParams: () => ({ bookId: "1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/b/1/transactions",
  })
);

const account = (id: number, name: string, type: string, subtype: string | null): AccountWithBalance => ({
  id, bookId: 1, name, type, subtype, parentId: null, isActive: true, isInvestmentCash: false, icon: null,
  isFavorite: false, createdAt: new Date(), updatedAt: new Date(), balance: 0, hasTransactions: true,
} as AccountWithBalance);

const CHECKING = 3;
const accounts = [
  account(CHECKING, "Checking", "asset", "bank"),
  account(4, "Groceries", "expense", null),
  account(6, "Household", "expense", null),
  account(7, "Sales Tax", "expense", null),
  account(99, "Dining", "expense", null),
];

const groceries = (over: Partial<EntryPattern> = {}): EntryPattern => ({
  key: "4:in", splits: [{ accountId: 4, amount: 4210 }, { accountId: CHECKING, amount: -4210 }],
  count: 3, lastDate: "2026-10-01", stable: true, range: { min: 4210, max: 4210 }, ...over,
});
const household: EntryPattern = {
  key: "6:in", splits: [{ accountId: 6, amount: 9000 }, { accountId: CHECKING, amount: -9000 }],
  count: 2, lastDate: "2026-09-20", stable: true, range: { min: 9000, max: 9000 },
};

type Setup = { patterns: EntryPattern[]; entry?: boolean };

/** The fetch mock. `answer` resolves the TypeSafe POST; `outcomes` holds the outcome bodies. */
function mockFetch({ patterns, entry = false }: Setup) {
  // One deferred answer per TypeSafe request; `answer` resolves the oldest open one.
  const pending: Array<(value: unknown) => void> = [];
  const settings = { revision: 1 };
  const outcomes: unknown[] = [];
  const suggestions: unknown[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/entry-suggestion/outcome")) {
      outcomes.push(JSON.parse(String(init?.body)));
      return reply({ success: true });
    }
    if (url.includes("/entry-suggestion")) {
      suggestions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => { pending.push(resolve); }).then(reply);
    }
    if (url.includes("/entry-patterns")) {
      const payeeId = Number(url.match(/payees\/(\d+)/)?.[1]);
      return reply({ patterns: payeeId === 7 ? patterns : [] });
    }
    if (url.includes("/last-account")) return reply({ accountId: 99 });
    if (url === "/api/b/1/accounts" && init?.method === "POST") return reply({ id: 50 });
    if (url.includes("/settings/typesafe")) {
      return reply({ enabled: false, entrySuggestionsEnabled: entry, configured: true, revision: settings.revision });
    }
    if (url.startsWith("/api/b/1/payees")) return reply([{ id: 7, name: "Costco" }, { id: 8, name: "Corner Shop" }]);
    return reply([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, outcomes, suggestions, settings, answer: (value: unknown) => pending.shift()?.(value) };
}

function renderForm(
  onSubmit = vi.fn().mockResolvedValue(true),
  list = accounts,
  extra: { fullLayout?: boolean; onCancel?: () => void } = {},
) {
  const view = render(
    <ToastProvider>
      <TransactionForm accounts={list} selectedAccountId={CHECKING} onSubmit={onSubmit} {...extra} />
    </ToastProvider>,
  );
  const rerender = (next: AccountWithBalance[]) =>
    view.rerender(
      <ToastProvider>
        <TransactionForm accounts={next} selectedAccountId={CHECKING} onSubmit={onSubmit} />
      </ToastProvider>,
    );
  return Object.assign(onSubmit, { rerender, unmount: () => view.unmount() });
}

// The form waits on two timers: the payee search and the TypeSafe request.
// The tests use a fake clock and move it on purpose, so that each test can
// check the state on both sides of a wait. `waitFor` is not used: under a fake
// setTimeout it never returns.

/** Moves the fake clock, then lets React finish the work that the timers start. */
async function elapse(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/** Lets pending promises and renders finish without a clock movement. */
const settle = () => elapse(0);

/** Types a payee name and ends the payee search wait. */
async function pickPayee(name: string) {
  fireEvent.change(screen.getByLabelText("Payee"), { target: { value: name } });
  await elapse(PAYEE_SEARCH_DELAY_MS);
}

/** Ends the wait before the TypeSafe request. */
const elapseSuggestionDelay = () => elapse(SUGGESTION_DELAY_MS);

describe("TransactionForm entry fill", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() });
  });
  afterEach(() => {
    // Unmount while the fetch mock and the fake clock are still in place, so
    // an outcome sent on unmount reaches the mock. Then discard the timers
    // that are left, so that none of them runs in a later test.
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fills from history without TypeSafe", async () => {
    const mock = mockFetch({ patterns: [groceries(), household] });
    const onSubmit = renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
    expect(screen.getByLabelText("Amount")).toHaveValue("42.10");
    expect(screen.getByRole("button", { name: /Filled from: Groceries · \$42\.10 \(history\)/ })).toBeInTheDocument();
    await elapseSuggestionDelay();
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.suggestions).toHaveLength(0);
    expect(mock.outcomes).toHaveLength(0);
  });

  it("leaves the amount empty with a range hint when it does not repeat", async () => {
    mockFetch({ patterns: [groceries({ stable: false, range: { min: 3120, max: 16400 } })] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(screen.getByText("usually $31.20–$164.00")).toBeInTheDocument();
  });

  it("describes the empty amount field with the range hint", async () => {
    mockFetch({ patterns: [groceries({ stable: false, range: { min: 3120, max: 16400 } })] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveAccessibleDescription("usually $31.20–$164.00");
    // The range is shown once, under the field; the chip does not repeat it.
    expect(screen.getAllByText(/\$31\.20–\$164\.00/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Filled from: Groceries (history)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "55.00" } });
    expect(screen.queryByText(/usually/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).not.toHaveAccessibleDescription();
    expect(screen.getByRole("button", { name: "Filled from: Groceries (history)" })).toBeInTheDocument();
  });

  it("describes the empty amount field with the range hint in the full layout", async () => {
    mockFetch({ patterns: [groceries({ stable: false, range: { min: 3120, max: 16400 } })] });
    renderForm(undefined, accounts, { fullLayout: true });
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveAccessibleDescription("usually $31.20–$164.00");
  });

  it("gives each mounted form its own range hint", async () => {
    mockFetch({ patterns: [groceries({ stable: false, range: { min: 3120, max: 16400 } })] });
    // The register mounts the desktop and the mobile form at once.
    render(
      <ToastProvider>
        <div data-testid="desktop">
          <TransactionForm accounts={accounts} selectedAccountId={CHECKING} onSubmit={vi.fn()} />
        </div>
        <div data-testid="mobile">
          <TransactionForm accounts={accounts} selectedAccountId={CHECKING} onSubmit={vi.fn()} fullLayout />
        </div>
      </ToastProvider>,
    );
    for (const form of ["desktop", "mobile"]) {
      fireEvent.change(within(screen.getByTestId(form)).getByLabelText("Payee"), { target: { value: "Costco" } });
    }
    await elapse(PAYEE_SEARCH_DELAY_MS);
    // Each Amount field points at the hint in its own form. With one fixed id,
    // the mobile field would point at the desktop form's hint.
    for (const form of ["desktop", "mobile"]) {
      const wrapper = screen.getByTestId(form);
      const amount = within(wrapper).getByLabelText("Amount");
      expect(amount).toHaveAccessibleDescription("usually $31.20–$164.00");
      const hint = document.getElementById(amount.getAttribute("aria-describedby") ?? "");
      expect(wrapper).toContainElement(hint);
    }
  });

  it("switches to journal mode for a pattern with two other accounts", async () => {
    mockFetch({
      patterns: [{
        key: "4:in|7:in", count: 2, lastDate: "2026-10-01", stable: true, range: { min: 5000, max: 5000 },
        splits: [{ accountId: 4, amount: 4500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -5000 }],
      }],
    });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("Sales Tax")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Groceries")).toBeInTheDocument();
  });

  it("applies the TypeSafe pick when the fields are untouched", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    expect(mock.suggestions[0]).toEqual({ accountId: CHECKING, payeeId: 7, date: expect.any(String), amount: null });
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByLabelText("To Account")).toHaveValue("Household");
    expect(screen.getByLabelText("Amount")).toHaveValue("90.00");
    expect(screen.getByRole("button", { name: /Filled from: Household · \$90\.00 \(Clef\)/ })).toBeInTheDocument();
  });

  it("does not apply the TypeSafe pick after the user edits the amount", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    expect(screen.getByLabelText("Amount")).toHaveValue("50.00");
  });

  it("drops a late answer for another payee", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    await pickPayee("Corner Shop");
    expect(screen.queryByRole("button", { name: /Filled from/ })).toBeNull();
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByLabelText("To Account")).not.toHaveValue("Household");
  });

  it("refills from the chip list, and posts picked_other after the save", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: null, confidence: 0.4 }); });
    const chip = screen.getByRole("button", { name: /Clef was not sure/ });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: /Household · \$90\.00 · 2 uses/ }));
    expect(screen.getByLabelText("To Account")).toHaveValue("Household");
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toEqual({
      evaluationId: 5, outcome: "picked_other", source: "history", chipVisible: true, pickedIndex: 1, transactionId: null,
    });
  });

  it("shows the next two patterns as buttons, and a click on one is a pick", async () => {
    const tax: EntryPattern = {
      key: "7:in", splits: [{ accountId: 7, amount: 300 }, { accountId: CHECKING, amount: -300 }],
      count: 2, lastDate: "2026-09-10", stable: true, range: { min: 300, max: 300 },
    };
    const dining: EntryPattern = {
      key: "99:in", splits: [{ accountId: 99, amount: 1500 }, { accountId: CHECKING, amount: -1500 }],
      count: 2, lastDate: "2026-09-01", stable: true, range: { min: 1500, max: 1500 },
    };
    const mock = mockFetch({ patterns: [groceries(), household, tax, dining], entry: true });
    const onSubmit = renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: null, confidence: 0.4 }); });
    const quick = screen.getByRole("group", { name: "Other patterns" });
    expect(within(quick).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Household · $90.00",
      "Sales Tax · $3.00",
    ]);
    fireEvent.click(within(quick).getByRole("button", { name: "Sales Tax · $3.00" }));
    expect(screen.getByLabelText("To Account")).toHaveValue("Sales Tax");
    expect(screen.getByRole("button", { name: /Filled from: Sales Tax · \$3\.00 \(your pick\)/ })).toBeInTheDocument();
    // The pattern shown leaves the buttons, and the one shown before joins them.
    expect(
      within(screen.getByRole("group", { name: "Other patterns" })).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Groceries · $42.10", "Household · $90.00"]);
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "picked_other", pickedIndex: 2 });
  });

  it("shows no pattern buttons when the payee has one pattern", async () => {
    mockFetch({ patterns: [groceries()] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: /Filled from: Groceries/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Other patterns" })).toBeNull();
  });

  it("falls back to the last-account fill when there are no patterns", async () => {
    mockFetch({ patterns: [] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Dining");
    expect(screen.queryByRole("button", { name: /Filled from/ })).toBeNull();
  });

  it("names the picked pattern in the chip after a chip pick", async () => {
    mockFetch({ patterns: [groceries(), household] });
    renderForm();
    await pickPayee("Costco");
    fireEvent.click(screen.getByRole("button", { name: /Filled from: Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: /Household · \$90\.00 · 2 uses/ }));
    expect(screen.getByRole("button", { name: /Filled from: Household · \$90\.00 \(your pick\)/ })).toBeInTheDocument();
  });

  it("keeps the history source in the chip and the outcome when a TypeSafe answer is dropped", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByRole("button", { name: /Filled from: Groceries · \$42\.10 \(history\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "changed_amount", source: "history", pickedIndex: null });
  });

  it("does not undo a mode switch when the TypeSafe answer arrives", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByDisplayValue("Household")).toBeNull();
  });

  it("keeps a new expense account when a later fill runs", async () => {
    const { fetchMock } = mockFetch({ patterns: [groceries(), household] });
    const form = Object.assign(renderForm(), { fetchMock });
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    fireEvent.click(screen.getByRole("button", { name: "+ Acct" }));
    fireEvent.change(screen.getByLabelText("New Expense Name"), { target: { value: "Pet Food" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await settle();
    expect(screen.queryByRole("button", { name: "Creating..." })).toBeNull();
    form.rerender([...accounts, account(50, "Pet Food", "expense", null)]);
    expect(screen.getByLabelText("To Account")).toHaveValue("Pet Food");
    // A new date reloads the patterns and fills again.
    const loads = () => form.fetchMock.mock.calls.filter(([url]) => String(url).includes("/entry-patterns")).length;
    const before = loads();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "10/01/2026" } });
    fireEvent.blur(screen.getByLabelText("Date"));
    await settle();
    expect(loads()).toBe(before + 1);
    expect(screen.getByRole("button", { name: /Filled from/ })).toBeInTheDocument();
    expect(screen.getByLabelText("To Account")).toHaveValue("Pet Food");
  });

  it("keeps a typed amount when the chip picks a pattern whose amount varies", async () => {
    mockFetch({ patterns: [groceries(), { ...household, stable: false, range: { min: 5000, max: 9000 } }] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveValue("42.10");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "55.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Filled from/ }));
    fireEvent.click(screen.getByRole("button", { name: /Household · \$50\.00–\$90\.00/ }));
    expect(screen.getByLabelText("To Account")).toHaveValue("Household");
    expect(screen.getByLabelText("Amount")).toHaveValue("55.00");
  });

  it("clears a filled amount when the chip picks a pattern whose amount varies", async () => {
    mockFetch({ patterns: [groceries(), { ...household, stable: false, range: { min: 5000, max: 9000 } }] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveValue("42.10");
    fireEvent.click(screen.getByRole("button", { name: /Filled from/ }));
    fireEvent.click(screen.getByRole("button", { name: /Household · \$50\.00–\$90\.00/ }));
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(screen.getByText("usually $50.00–$90.00")).toBeInTheDocument();
  });

  it("applies a journal pick after a typed amount, and keeps the amount on this account", async () => {
    const split: EntryPattern = {
      key: "4:in|7:in", count: 2, lastDate: "2026-09-01", stable: false, range: { min: 4000, max: 6000 },
      splits: [{ accountId: 4, amount: 4500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -5000 }],
    };
    mockFetch({ patterns: [groceries(), split] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveValue("42.10");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "55.00" } });
    fireEvent.click(screen.getByRole("button", { name: /Filled from/ }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries, Sales Tax/ }));
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("Sales Tax")).toBeInTheDocument();
    expect(screen.getByDisplayValue("55.00")).toBeInTheDocument();
  });

  it("drops a TypeSafe answer from before a settings change", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    mock.settings.revision = 2;
    act(() => notifyTypeSafeSettings("1"));
    await settle();
    // The new revision starts a new wait; the old request is not sent again before it ends.
    expect(mock.suggestions).toHaveLength(1);
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(2);
    // The answer to the first request arrives after the change.
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "6:in", confidence: 0.8 }); });
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
  });

  it("posts no outcome when the save fails", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm(vi.fn().mockResolvedValue(false));
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes).toHaveLength(0);
  });

  it("records kept when the chip reselects the pattern already shown", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm();
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: null, confidence: 0.4 }); });
    fireEvent.click(screen.getByRole("button", { name: /Filled from: Groceries/ }));
    fireEvent.click(screen.getByRole("button", { name: /Groceries · \$42\.10 · 3 uses/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "kept", pickedIndex: null });
  });

  it("sends the saved transaction's id when the save handler gives one", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm(vi.fn().mockResolvedValue(77));
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: null, confidence: 0.4 }); });
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "kept", transactionId: 77 });
  });

  it("clears an untouched fill when the payee no longer matches", async () => {
    mockFetch({ patterns: [groceries(), household] });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("Amount")).toHaveValue("42.10");
    await pickPayee("Costco Wholesale");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(screen.getByLabelText("To Account")).toHaveValue("");
    expect(screen.getByLabelText("From Account")).toHaveValue("Checking");
  });

  it("asks TypeSafe when the wait ends, and not before", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    await elapse(SUGGESTION_DELAY_MS - 1);
    expect(mock.suggestions).toHaveLength(0);
    await elapse(1);
    expect(mock.suggestions).toHaveLength(1);
    await elapse(10 * SUGGESTION_DELAY_MS);
    expect(mock.suggestions).toHaveLength(1);
  });

  it("waits before it asks TypeSafe, so a payee typed past makes no call", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    await elapse(SUGGESTION_DELAY_MS - 1);
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "Corner Shop" } });
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(0);
  });

  it("sends one request, for the new date, when the date changes during the wait", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    await pickPayee("Costco");
    await elapse(SUGGESTION_DELAY_MS - 1);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "10/01/2026" } });
    fireEvent.blur(screen.getByLabelText("Date"));
    await settle();
    // The first wait would have ended here; its request is dropped.
    await elapse(1);
    expect(mock.suggestions).toHaveLength(0);
    await elapseSuggestionDelay();
    expect(mock.suggestions).toEqual([expect.objectContaining({ payeeId: 7, date: "2026-10-01" })]);
  });

  it("sends a typed amount with its direction", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50.00" } });
    await pickPayee("Costco");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    expect(mock.suggestions[0]).toMatchObject({ amount: -5000 });
  });

  it("fills a repeating journal total on this account's line, with the hint", async () => {
    mockFetch({
      patterns: [{
        key: "4:in|7:in", count: 4, lastDate: "2026-10-01", stable: false, range: { min: 5000, max: 5000 },
        splits: [{ accountId: 4, amount: 4600 }, { accountId: 7, amount: 400 }, { accountId: CHECKING, amount: -5000 }],
      }],
    });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("50.00")).toBeInTheDocument();
    expect(screen.getByText("usually $50.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filled from: Groceries, Sales Tax (history)" })).toBeInTheDocument();
  });

  it("fills a journal pattern after a typed amount, and keeps the amount", async () => {
    mockFetch({
      patterns: [{
        key: "4:in|7:in", count: 2, lastDate: "2026-10-01", stable: false, range: { min: 4000, max: 6000 },
        splits: [{ accountId: 4, amount: 4500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -5000 }],
      }],
    });
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "55.00" } });
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("Sales Tax")).toBeInTheDocument();
    expect(screen.getByDisplayValue("55.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filled from/ })).toBeInTheDocument();
  });

  it("closes the pattern list with Escape and with a click outside", async () => {
    mockFetch({ patterns: [groceries(), household] });
    renderForm();
    await pickPayee("Costco");
    const chip = screen.getByRole("button", { name: /Filled from/ });
    fireEvent.click(chip);
    const list = screen.getByRole("list", { name: "Earlier patterns" });
    expect(chip).toHaveAttribute("aria-controls", list.id);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Earlier patterns" })).toBeNull();
    fireEvent.click(chip);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("list", { name: "Earlier patterns" })).toBeNull();
  });

  it("records abandoned once when the form closes without a save", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const form = renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    form.unmount();
    await settle();
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("records no abandoned outcome when the form closes during a save", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    let confirm: (saved: number) => void = () => undefined;
    const form = renderForm(vi.fn(() => new Promise<number>((resolve) => { confirm = resolve; })));
    await pickPayee("Costco");
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    // The entry stays until the answer, so the fill is still applied here.
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    form.unmount();
    await settle();
    expect(mock.outcomes).toHaveLength(0);
    // The save was not abandoned: its own outcome goes out when it succeeds.
    await act(async () => { confirm(77); });
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "kept", transactionId: 77 });
  });

  it("records no abandoned outcome when the form closes after a failed save", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const form = renderForm(vi.fn().mockResolvedValue(false));
    await pickPayee("Costco");
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    form.unmount();
    await settle();
    expect(mock.outcomes).toHaveLength(0);
  });

  it("records the outcome when the user saves again after a failed save", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    const onSubmit = renderForm(vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(78));
    await pickPayee("Costco");
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "kept", transactionId: 78 });
  });

  it("records abandoned once when Cancel closes the form", async () => {
    const mock = mockFetch({ patterns: [groceries(), household], entry: true });
    let close = () => undefined as void;
    const form = renderForm(vi.fn().mockResolvedValue(true), accounts, { fullLayout: true, onCancel: () => close() });
    close = () => form.unmount();
    await pickPayee("Costco");
    expect(screen.getByLabelText("To Account")).toHaveValue("Groceries");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(mock.outcomes).toHaveLength(1);
    expect(mock.outcomes[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("keeps a money-in fill when the accounts list refreshes", async () => {
    mockFetch({
      patterns: [{
        key: "4:out", count: 2, lastDate: "2026-10-01", stable: true, range: { min: 700, max: 700 },
        splits: [{ accountId: CHECKING, amount: 700 }, { accountId: 4, amount: -700 }],
      }],
    });
    const form = renderForm();
    await pickPayee("Costco");
    expect(screen.getByLabelText("From Account")).toHaveValue("Groceries");
    expect(screen.getByLabelText("To Account")).toHaveValue("Checking");
    form.rerender([...accounts, account(51, "New Account", "asset", "bank")]);
    await settle();
    expect(screen.getByLabelText("From Account")).toHaveValue("Groceries");
  });

  it("keeps a typed amount when TypeSafe confirms a journal fill", async () => {
    const split: EntryPattern = {
      key: "4:in|7:in", count: 2, lastDate: "2026-10-01", stable: false, range: { min: 4000, max: 6000 },
      splits: [{ accountId: 4, amount: 4500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -5000 }],
    };
    const mock = mockFetch({ patterns: [split, groceries()], entry: true });
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "55.00" } });
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    expect(mock.suggestions[0]).toMatchObject({ amount: -5500 });
    await act(async () => { mock.answer({ status: "ready", evaluationId: 5, choice: "4:in|7:in", confidence: 0.9 }); });
    expect(screen.getByDisplayValue("55.00")).toBeInTheDocument();
  });

  it("puts a repeating total on one line when the pattern has two lines on this account", async () => {
    mockFetch({
      patterns: [{
        key: "4:in|7:in", count: 4, lastDate: "2026-10-01", stable: false, range: { min: 5000, max: 5000 },
        splits: [
          { accountId: 4, amount: 4600 }, { accountId: 7, amount: 400 },
          { accountId: CHECKING, amount: -3000 }, { accountId: CHECKING, amount: -2000 },
        ],
      }],
    });
    renderForm();
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByDisplayValue("50.00")).toHaveLength(1);
  });

  it("keeps an amount edited in journal mode when the chip picks a pattern whose amount varies", async () => {
    const repeating: EntryPattern = {
      key: "4:in|7:in", count: 4, lastDate: "2026-10-01", stable: false, range: { min: 5000, max: 5000 },
      splits: [{ accountId: 4, amount: 4600 }, { accountId: 7, amount: 400 }, { accountId: CHECKING, amount: -5000 }],
    };
    const varying: EntryPattern = {
      key: "6:in|7:in", count: 2, lastDate: "2026-09-01", stable: false, range: { min: 3000, max: 9000 },
      splits: [{ accountId: 6, amount: 5500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -6000 }],
    };
    mockFetch({ patterns: [repeating, varying] });
    renderForm();
    await pickPayee("Costco");
    const credit = screen.getByDisplayValue("50.00");
    fireEvent.change(credit, { target: { value: "55.00" } });
    fireEvent.blur(credit);
    fireEvent.click(screen.getByRole("button", { name: /Filled from/ }));
    fireEvent.click(screen.getByRole("button", { name: /Household, Sales Tax/ }));
    expect(screen.getByDisplayValue("Household")).toBeInTheDocument();
    expect(screen.getByDisplayValue("55.00")).toBeInTheDocument();
  });

  it("keeps an amount typed as an expression", async () => {
    const mock = mockFetch({
      patterns: [{
        key: "4:in|7:in", count: 2, lastDate: "2026-10-01", stable: false, range: { min: 4000, max: 6000 },
        splits: [{ accountId: 4, amount: 4500 }, { accountId: 7, amount: 500 }, { accountId: CHECKING, amount: -5000 }],
      }, groceries()],
      entry: true,
    });
    renderForm();
    const amount = screen.getByLabelText("Amount");
    fireEvent.change(amount, { target: { value: "50+5" } });
    fireEvent.blur(amount);
    expect(amount).toHaveValue("55.00");
    await pickPayee("Costco");
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("55.00")).toBeInTheDocument();
    await elapseSuggestionDelay();
    expect(mock.suggestions).toHaveLength(1);
    expect(mock.suggestions[0]).toMatchObject({ amount: -5500 });
  });
});
