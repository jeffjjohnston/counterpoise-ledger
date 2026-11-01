/** A message of the book socket: `{"type":"ready"}` or a change hint. */
export type Hint = { type: string; tables?: string[] };

/** A WebSocket that queues its messages and its close, so a test reads them in order. */
export function openSocket(url: string, headers: Record<string, string>) {
  // Node's WebSocket takes request headers, as a native client sends them.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  const queue: Hint[] = [];
  let waiter: (() => void) | undefined;
  let closed: { code: number; reason: string } | undefined;
  let failed = false;
  const wake = () => { waiter?.(); waiter = undefined; };
  socket.addEventListener("message", (event) => { queue.push(JSON.parse(String(event.data)) as Hint); wake(); });
  socket.addEventListener("close", (event) => { closed = { code: event.code, reason: event.reason }; wake(); });
  socket.addEventListener("error", () => { failed = true; wake(); });
  async function until<T>(take: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = take();
      if (value !== undefined) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`No ${what} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }
  return {
    /** The next message. */
    next: (timeoutMs = 5000) => until(() => {
      if (queue.length) return queue.shift();
      if (closed || failed) throw new Error(`The socket ended: ${JSON.stringify(closed)}`);
      return undefined;
    }, "message", timeoutMs),
    /** The close, after any messages before it. */
    closed: (timeoutMs = 5000) => until(() => closed, "close", timeoutMs),
    /** Reads messages until none arrives for `quietMs`: the hints of the fixtures. */
    async settle(quietMs = 600) {
      for (;;) {
        try {
          await this.next(quietMs);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("No message")) return;
          throw error;
        }
      }
    },
    close: (code?: number) => socket.close(code),
  };
}

/** The hint of a change to these tables, in this order. */
export function changeHint(...tables: string[]): Hint {
  return { type: "change", tables };
}

/**
 * A hint with its tables sorted. The server reads the change counts of one
 * poll in no fixed order, so only the order of tables from different polls
 * is stable.
 */
export function sortedHint(hint: Hint): Hint {
  return hint.tables ? { ...hint, tables: [...hint.tables].sort() } : hint;
}
