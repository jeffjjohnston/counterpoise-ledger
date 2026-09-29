import { ApiError, apiDelete, apiPut } from "@/lib/api-client";

// These client calls edit or delete a transaction that the user loaded.
// Each call sends the updatedAt value from that load. If another user
// changed the row after the load, the server refuses the change (HTTP 409).

export const TRANSACTION_CONFLICT_MESSAGE =
  "Another user changed this transaction. Showing the latest version.";

type Loaded = { id: number; updatedAt: Date | string };

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

export function putTransaction<T>(bookId: string, transaction: Loaded, body: object): Promise<T> {
  return apiPut<T>(`/api/b/${bookId}/transactions/${transaction.id}`, {
    ...body,
    expectedUpdatedAt: iso(transaction.updatedAt),
  });
}

export function deleteTransactionRequest(bookId: string, transaction: Loaded): Promise<unknown> {
  const query = new URLSearchParams({ expectedUpdatedAt: iso(transaction.updatedAt) });
  return apiDelete(`/api/b/${bookId}/transactions/${transaction.id}?${query}`);
}

export function isTransactionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}
