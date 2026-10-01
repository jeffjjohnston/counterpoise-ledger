export type Frame = { event?: string; data?: string; comment?: string };

/** Reads SSE frames from a real response body, one blank-line block at a time. */
export function frameReader(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  // A read that a timeout left open. The next call waits for it, so that no
  // chunk is lost.
  let pending: Promise<ReadableStreamReadResult<string>> | undefined;
  return {
    async next(timeoutMs = 5000): Promise<Frame | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (!buffered.includes("\n\n")) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`No SSE frame within ${timeoutMs} ms; buffered ${JSON.stringify(buffered)}`);
        pending ??= reader.read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          pending,
          new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); }),
        ]).finally(() => clearTimeout(timer));
        if (chunk === "timeout") continue;
        pending = undefined;
        if (chunk.done) return undefined;
        buffered += chunk.value;
      }
      const end = buffered.indexOf("\n\n");
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const frame: Frame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      return frame;
    },
    cancel: () => reader.cancel(),
  };
}

/** The frame of a change hint for these tables, in this order. */
export function changeFrame(...tables: string[]): Frame {
  return { event: "change", data: JSON.stringify({ tables }) };
}

/**
 * The event and the sorted tables of a frame. The server reads the change
 * counts of one poll in no fixed order, so only the order of tables from
 * different polls is stable.
 */
export function changeTables(frame: Frame | undefined): { event?: string; tables?: string[] } {
  if (!frame) return {};
  const tables = frame.data ? (JSON.parse(frame.data) as { tables?: string[] }).tables : undefined;
  return { event: frame.event, tables: tables ? [...tables].sort() : tables };
}

/**
 * Reads and discards frames until none arrives for `quietMs`. The default is
 * more than one poll (100 ms) and one window (250 ms) of the server, so every
 * hint of an earlier write has arrived. A test calls it after its fixtures,
 * before the write that it checks.
 */
export async function settle(frames: ReturnType<typeof frameReader>, quietMs = 600): Promise<Frame[]> {
  const discarded: Frame[] = [];
  for (;;) {
    let frame: Frame | undefined;
    try {
      frame = await frames.next(quietMs);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No SSE frame within")) return discarded;
      throw error;
    }
    if (!frame) throw new Error("The SSE stream ended while it settled");
    discarded.push(frame);
  }
}
