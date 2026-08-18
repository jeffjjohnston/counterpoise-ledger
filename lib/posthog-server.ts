import { PostHog } from "posthog-node";

let client: PostHog | null | undefined;

export function getPostHogServer(): PostHog | null {
  if (client !== undefined) return client;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!key) {
    client = null;
    return null;
  }

  client = new PostHog(key, {
    host: host || undefined,
    flushAt: 1,
    flushInterval: 0,
  });

  return client;
}

export function captureEvent(
  userId: number,
  event: string,
  properties?: Record<string, unknown>
): void {
  const posthog = getPostHogServer();
  if (!posthog) return;

  posthog.capture({
    distinctId: String(userId),
    event,
    properties,
  });
}

// ---------------------------------------------------------------------------
// Transaction field diff for telemetry
// ---------------------------------------------------------------------------

interface ExistingTransaction {
  date: string;
  description: string | null;
  notes: string | null;
  checkNumber: string | null;
  isReconciled: boolean;
  payee: { name: string } | null;
  splits: { accountId: number; amount: number }[];
}

interface UpdateBody {
  date?: string;
  description?: string;
  notes?: string | null;
  checkNumber?: string;
  isReconciled?: boolean;
  payeeName?: string | null;
  splits?: { accountId: number; amount: number }[];
}

export function diffTransactionFields(
  existing: ExistingTransaction,
  body: UpdateBody
): { fieldsChanged: string[]; splitsAccountsChanged: boolean } {
  const changed: string[] = [];
  let splitsAccountsChanged = false;

  if (body.date !== undefined && body.date !== existing.date) {
    changed.push("date");
  }

  if (body.description !== undefined && (body.description ?? null) !== (existing.description ?? null)) {
    changed.push("description");
  }

  if (body.notes !== undefined && (body.notes ?? null) !== (existing.notes ?? null)) {
    changed.push("notes");
  }

  if (body.checkNumber !== undefined && (body.checkNumber ?? null) !== (existing.checkNumber ?? null)) {
    changed.push("checkNumber");
  }

  if (body.isReconciled !== undefined && body.isReconciled !== existing.isReconciled) {
    changed.push("isReconciled");
  }

  if (body.payeeName !== undefined) {
    const oldPayee = existing.payee?.name ?? "";
    const newPayee = body.payeeName ?? "";
    if (oldPayee.toLowerCase() !== newPayee.toLowerCase()) {
      changed.push("payeeName");
    }
  }

  if (body.splits !== undefined) {
    const oldAccounts = existing.splits.map((s) => s.accountId).sort((a, b) => a - b);
    const newAccounts = body.splits.map((s) => s.accountId).sort((a, b) => a - b);

    const accountsMatch =
      oldAccounts.length === newAccounts.length &&
      oldAccounts.every((id, i) => id === newAccounts[i]);

    if (!accountsMatch) {
      splitsAccountsChanged = true;
    }

    const oldKey = existing.splits
      .map((s) => `${s.accountId}:${s.amount}`)
      .sort()
      .join(",");
    const newKey = body.splits
      .map((s) => `${s.accountId}:${s.amount}`)
      .sort()
      .join(",");

    if (oldKey !== newKey) {
      changed.push("splits");
    }
  }

  return { fieldsChanged: changed, splitsAccountsChanged };
}
