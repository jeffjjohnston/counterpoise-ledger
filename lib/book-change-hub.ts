export type BookChange = { type: "change" | "reset"; tables: string[] };
export type ListenForChanges = (
  notify: (payload: string) => void,
  ready: () => void,
) => Promise<{ unlisten: () => Promise<unknown> }>;

const CHANGE_TABLES = new Set([
  "transactions", "transaction_splits", "investment_splits", "investment_lots",
  "books", "book_members", "accounts", "payees", "securities", "security_prices", "recurring_rules",
  "recurring_template_splits", "plaid_accounts", "plaid_transaction_reconciliation",
]);

/** One hub per process, with no I/O until the first subscription. */
export function createBookChangeHub(listen: ListenForChanges) {
  const subscribers = new Map<number, Set<(change: BookChange) => void>>();
  const pending = new Map<number, { tables: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  let connection: ReturnType<ListenForChanges> | undefined;
  let disposed = false;

  function emit(bookId: number, change: BookChange) {
    for (const callback of subscribers.get(bookId) ?? []) {
      try { callback(change); }
      catch (error) { console.error("Book change subscriber failed", error); }
    }
  }

  function notify(payload: string) {
    if (disposed) return;
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return; }
    if (!value || typeof value !== "object") return;
    const { bookId, table } = value as { bookId?: unknown; table?: unknown };
    if (typeof bookId !== "number" || !Number.isSafeInteger(bookId) || bookId <= 0 ||
        typeof table !== "string" || !CHANGE_TABLES.has(table) || !subscribers.has(bookId)) return;
    const existing = pending.get(bookId);
    if (existing) { existing.tables.add(table); return; }
    // Fixed windows, rather than an endlessly postponed trailing debounce:
    // continuous imports still deliver updates at a bounded rate.
    const tables = new Set([table]);
    const timer = setTimeout(() => {
      pending.delete(bookId);
      emit(bookId, { type: "change", tables: [...tables] });
    }, 250);
    pending.set(bookId, { tables, timer });
  }

  function reset() {
    if (disposed) return;
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const bookId of subscribers.keys()) emit(bookId, { type: "reset", tables: [] });
  }

  return {
    subscribe(bookId: number, callback: (change: BookChange) => void) {
      if (disposed) throw new Error("Book change hub is closed");
      const callbacks = subscribers.get(bookId) ?? new Set();
      callbacks.add(callback);
      subscribers.set(bookId, callbacks);
      connection ??= listen(notify, reset).catch((error) => {
        connection = undefined;
        throw error;
      });
      let subscribed = true;
      return {
        ready: connection.then(() => {}),
        unsubscribe() {
          if (!subscribed) return;
          subscribed = false;
          callbacks.delete(callback);
          if (callbacks.size) return;
          subscribers.delete(bookId);
          const work = pending.get(bookId);
          if (work) clearTimeout(work.timer);
          pending.delete(bookId);
        },
      };
    },
    async dispose() {
      disposed = true;
      subscribers.clear();
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      if (connection) await (await connection).unlisten();
    },
  };
}
