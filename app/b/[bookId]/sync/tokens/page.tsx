"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { MenuButton } from "@/components/ui/MenuButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { Modal } from "@/components/ui/Modal";
import { flattenAccounts } from "@/lib/accounting";
import { cn } from "@/lib/utils";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import type {
  AccountWithBalance,
  PlaidAccountAssignment,
  PlaidTokenListItem,
} from "@/types";

type NewTokenForm = {
  financialInstitution: string;
  itemId: string;
  accessToken: string;
};

type EditTokenForm = {
  financialInstitution: string;
  itemId: string;
  accessToken: string;
};

const initialFormState: NewTokenForm = {
  financialInstitution: "",
  itemId: "",
  accessToken: "",
};

const initialEditFormState: EditTokenForm = {
  financialInstitution: "",
  itemId: "",
  accessToken: "",
};

export default function SyncTokensPage() {
  const router = useRouter();
  const bookId = useBookId();
  const [tokens, setTokens] = useState<PlaidTokenListItem[]>([]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState<NewTokenForm>(initialFormState);
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editingToken, setEditingToken] = useState<PlaidTokenListItem | null>(null);
  const [editForm, setEditForm] = useState<EditTokenForm>(initialEditFormState);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<PlaidTokenListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedToken, setSelectedToken] = useState<PlaidTokenListItem | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountAssignment[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Accounts a Plaid account can map to: active bank or credit-card accounts.
  const assignableAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.isActive &&
          (account.subtype === "bank" || account.subtype === "credit_card")
      ),
    [accounts]
  );

  const fetchTokens = useCallback(async () => {
    const data = await apiGet<PlaidTokenListItem[]>(`/api/b/${bookId}/sync/tokens`);
    setTokens(Array.isArray(data) ? data : []);
  }, [bookId]);

  // The row behind the assignment modal reports "N of M accounts mapped" and
  // gates the amber warning on it. Both the Plaid refresh (which upserts
  // plaidAccounts server-side) and a save change those numbers, so the list
  // has to be re-read or the row keeps reporting the state before the fix.
  // Best-effort: a stale count is a far smaller problem than losing the modal.
  const refreshTokenCounts = useCallback(async () => {
    try {
      await fetchTokens();
    } catch {
      // Left stale until the next load.
    }
  }, [fetchTokens]);

  const fetchAccounts = useCallback(async () => {
    // Degrades to [] on failure rather than throwing — the account list only
    // feeds the assignment dropdown, so a failure here shouldn't block the
    // token list (fetchTokens, above) from loading.
    try {
      const data = await apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts`);
      const flatAccounts = flattenAccounts(Array.isArray(data) ? data : []);
      setAccounts(
        [...flatAccounts].sort((a, b) => a.name.localeCompare(b.name))
      );
    } catch {
      setAccounts([]);
    }
  }, [bookId]);

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        setLoading(true);
        setError(null);
        await Promise.all([fetchTokens(), fetchAccounts()]);
      } catch (fetchError) {
        const message = toMessage(fetchError, "Failed to load bank connections");
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    // fetchInitialData already catches its own errors into `error`, so
    // this cannot reject.
    void fetchInitialData();
  }, [fetchAccounts, fetchTokens]);

  const closeAddModal = () => {
    setShowAddModal(false);
    setForm(initialFormState);
    setAddError(null);
    setSubmitting(false);
  };

  const handleAddToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setAddError(null);

    try {
      await apiPost(`/api/b/${bookId}/sync/tokens`, form);
      await fetchTokens();
      closeAddModal();
    } catch (submitError) {
      const message = toMessage(submitError, "Failed to add connection");
      setAddError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteToken = async (tokenId: number) => {
    setError(null);
    setDeleting(true);

    try {
      await apiDelete(`/api/b/${bookId}/sync/tokens/${tokenId}`);
      await fetchTokens();
    } catch (deleteError) {
      const message = toMessage(deleteError, "Failed to remove connection");
      setError(message);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleOpenEditModal = (token: PlaidTokenListItem) => {
    setEditingToken(token);
    setEditForm({
      financialInstitution: token.financialInstitution,
      itemId: token.itemId,
      accessToken: "",
    });
    setEditError(null);
    setEditSaving(false);
    setShowEditModal(true);
  };

  const closeEditModal = () => {
    setShowEditModal(false);
    setEditingToken(null);
    setEditForm(initialEditFormState);
    setEditError(null);
    setEditSaving(false);
  };

  const handleSaveEditedToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingToken) return;

    setEditSaving(true);
    setEditError(null);

    try {
      await apiPut(`/api/b/${bookId}/sync/tokens/${editingToken.id}`, editForm);
      await fetchTokens();
      closeEditModal();
    } catch (saveError) {
      const message = toMessage(saveError, "Failed to update connection");
      setEditError(message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleOpenAssignModal = async (token: PlaidTokenListItem) => {
    setShowAssignModal(true);
    setSelectedToken(token);
    setAssignLoading(true);
    setAssignSaving(false);
    setAssignError(null);
    setPlaidAccounts([]);

    try {
      const payload = await apiGet<PlaidAccountAssignment[]>(
        `/api/b/${bookId}/sync/tokens/${token.id}/accounts?refresh=true`
      );
      setPlaidAccounts(Array.isArray(payload) ? payload : []);
    } catch (fetchError) {
      const message = toMessage(fetchError, "Failed to refresh Plaid accounts");
      setAssignError(message);
    } finally {
      setAssignLoading(false);
    }

    await refreshTokenCounts();
  };

  const closeAssignModal = () => {
    setShowAssignModal(false);
    setSelectedToken(null);
    setPlaidAccounts([]);
    setAssignError(null);
    setAssignLoading(false);
    setAssignSaving(false);
  };

  const handleAssignmentChange = (plaidAccountId: string, value: string) => {
    setPlaidAccounts((prev) =>
      prev.map((entry) =>
        entry.plaidAccountId === plaidAccountId
          ? {
              ...entry,
              counterpoiseAccountId: value ? Number.parseInt(value, 10) : null,
            }
          : entry
      )
    );
  };

  const handleSaveAssignments = async () => {
    if (!selectedToken) return;

    setAssignSaving(true);
    setAssignError(null);

    try {
      const payload = await apiPut<PlaidAccountAssignment[]>(
        `/api/b/${bookId}/sync/tokens/${selectedToken.id}/accounts`,
        {
          assignments: plaidAccounts.map((entry) => ({
            plaidAccountId: entry.plaidAccountId,
            counterpoiseAccountId: entry.counterpoiseAccountId,
          })),
        }
      );
      setPlaidAccounts(Array.isArray(payload) ? payload : []);
      await refreshTokenCounts();
      closeAssignModal();
    } catch (saveError) {
      const message = toMessage(saveError, "Failed to save assignments");
      setAssignError(message);
    } finally {
      setAssignSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Bank connections</h1>
        <div className="inline-flex items-center gap-2">
          <Button onClick={() => setShowAddModal(true)}>Add connection</Button>
          <Button variant="secondary" onClick={() => router.push(`/b/${bookId}/sync`)}>
            Back to Sync
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-danger-subtle border border-border rounded-lg p-4 text-sm text-fg-danger">
          {error}
        </div>
      )}

      {tokens.length === 0 ? (
        <div className="bg-surface rounded-lg border border-border">
          <EmptyState
            title="No banks connected yet"
            description="Add a connection to start syncing transactions from your bank."
            action={{ label: "Add connection", onClick: () => setShowAddModal(true) }}
          />
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-border overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider bg-surface-secondary">
                <th className="px-4 py-3">Bank</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {tokens.map((token) => {
                const isFullyMapped =
                  token.totalAccountCount > 0 &&
                  token.mappedAccountCount === token.totalAccountCount;
                const hasUnmapped = token.totalAccountCount > token.mappedAccountCount;
                // A connection with nothing loaded from the bank yet is not
                // "mapped" — treat it as needing attention too, not as a
                // healthy zero-of-zero.
                const needsAttention = token.totalAccountCount === 0 || hasUnmapped;

                return (
                  <tr key={token.id} className={cn(needsAttention && "bg-warning-subtle")}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2 w-2 flex-none rounded-full",
                            needsAttention ? "bg-[var(--fg-warning)]" : "bg-[var(--fg-success)]"
                          )}
                          role="status"
                          aria-label={
                            isFullyMapped
                              ? "All accounts mapped"
                              : token.totalAccountCount === 0
                                ? "Accounts not loaded yet"
                                : "Some accounts not mapped"
                          }
                        />
                        <span className="text-sm font-medium text-fg">
                          {token.financialInstitution}
                        </span>
                      </div>
                      {token.totalAccountCount === 0 ? (
                        <p className="mt-0.5 text-13 text-fg-warning">
                          Accounts have not been loaded from the bank yet — Map accounts will fetch them.
                          <span className="text-border"> · </span>
                          <span className="font-mono text-xs">{token.itemId}</span>
                        </p>
                      ) : hasUnmapped ? (
                        <p className="mt-0.5 text-13 text-fg-warning">
                          {token.mappedAccountCount} of {token.totalAccountCount} accounts mapped — the rest
                          will not sync until you map them.
                          <span className="text-border"> · </span>
                          <span className="font-mono text-xs">{token.itemId}</span>
                        </p>
                      ) : (
                        <p className="mt-0.5 text-13 text-fg-tertiary">
                          {token.mappedAccountCount} of {token.totalAccountCount} accounts mapped
                          <span className="text-border"> · </span>
                          <span className="font-mono text-xs">{token.itemId}</span>
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Button
                          size="sm"
                          variant={needsAttention ? "primary" : "secondary"}
                          onClick={() => void handleOpenAssignModal(token)}
                        >
                          Map accounts
                        </Button>
                        <MenuButton
                          label={`${token.financialInstitution} actions`}
                          items={[
                            { label: "Edit", onSelect: () => handleOpenEditModal(token) },
                            {
                              label: "Remove connection",
                              variant: "danger",
                              onSelect: () => setDeleteTarget(token),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={showAddModal} onClose={closeAddModal} title="Add connection">
        <div className="mb-5 rounded-lg border border-border bg-accent-subtle p-3">
          <p className="text-13 leading-relaxed text-fg-secondary">
            Counterpoise does not run Plaid&rsquo;s sign-in flow itself. Run{" "}
            <code className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs">
              npm run plaid:link
            </code>{" "}
            to sign in at your bank; it prints the item ID and access token to paste below.
          </p>
        </div>
        <form className="space-y-4" onSubmit={handleAddToken}>
          <Input
            id="financialInstitution"
            label="Bank name"
            value={form.financialInstitution}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                financialInstitution: event.target.value,
              }))
            }
          />
          <div>
            <Input
              id="itemId"
              label="Item ID"
              value={form.itemId}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, itemId: event.target.value }))
              }
            />
            <p className="mt-1 text-xs text-fg-tertiary">
              Starts with <span className="font-mono">item-</span>. Identifies the connection at Plaid.
            </p>
          </div>
          <div>
            <Input
              id="accessToken"
              label="Access Token"
              type="password"
              value={form.accessToken}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, accessToken: event.target.value }))
              }
            />
            <p className="mt-1 text-xs text-fg-tertiary">
              Starts with <span className="font-mono">access-</span>. Stored on the server; never shown again.
            </p>
          </div>
          {addError && <p className="text-sm text-fg-danger">{addError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeAddModal}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding…" : "Add connection"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={showEditModal}
        onClose={closeEditModal}
        title="Edit connection"
      >
        <form className="space-y-4" onSubmit={handleSaveEditedToken}>
          <Input
            id="edit-financialInstitution"
            label="Bank name"
            value={editForm.financialInstitution}
            onChange={(event) =>
              setEditForm((prev) => ({
                ...prev,
                financialInstitution: event.target.value,
              }))
            }
          />
          <Input
            id="edit-itemId"
            label="Item ID"
            value={editForm.itemId}
            onChange={(event) =>
              setEditForm((prev) => ({ ...prev, itemId: event.target.value }))
            }
          />
          <div>
            <Input
              id="edit-accessToken"
              label="New access token"
              type="password"
              value={editForm.accessToken}
              onChange={(event) =>
                setEditForm((prev) => ({
                  ...prev,
                  accessToken: event.target.value,
                }))
              }
            />
            <p className="text-xs text-fg-tertiary mt-1">
              Leave blank to keep the current access token.
            </p>
          </div>
          {editError && (
            <p className="text-sm text-fg-danger">{editError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeEditModal}>
              Cancel
            </Button>
            <Button type="submit" disabled={editSaving}>
              {editSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={showAssignModal}
        onClose={closeAssignModal}
        title={`Map accounts${selectedToken ? ` - ${selectedToken.financialInstitution}` : ""}`}
        size="lg"
      >
        {assignLoading ? (
          <div className="flex items-center gap-3 py-6">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
            <p className="text-sm text-fg-secondary">Refreshing accounts from Plaid…</p>
          </div>
        ) : assignError ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-danger">{assignError}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeAssignModal}>
                Close
              </Button>
              <Button onClick={() => selectedToken && void handleOpenAssignModal(selectedToken)}>
                Try again
              </Button>
            </div>
          </div>
        ) : plaidAccounts.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              No accounts were returned for this connection.
            </p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={closeAssignModal}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 max-h-[55vh] overflow-auto pr-1">
              {plaidAccounts.map((plaidAccount) => (
                <div
                  key={plaidAccount.plaidAccountId}
                  className="grid grid-cols-1 md:grid-cols-2 gap-3 border border-border rounded-lg p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-fg">
                      {plaidAccount.name}
                      {plaidAccount.mask ? ` ••••${plaidAccount.mask}` : ""}
                    </p>
                    <p className="text-xs text-fg-tertiary mt-1">
                      {plaidAccount.type}
                      {plaidAccount.subtype ? ` / ${plaidAccount.subtype}` : ""}
                      {plaidAccount.officialName
                        ? ` - ${plaidAccount.officialName}`
                        : ""}
                    </p>
                  </div>
                  <AccountAutocomplete
                    accounts={assignableAccounts}
                    value={plaidAccount.counterpoiseAccountId}
                    onChange={(accountId) =>
                      handleAssignmentChange(
                        plaidAccount.plaidAccountId,
                        accountId === null ? "" : String(accountId)
                      )
                    }
                    label="Counterpoise account"
                    placeholder="Search accounts…"
                    allowClear
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeAssignModal}>
                Cancel
              </Button>
              <Button onClick={handleSaveAssignments} disabled={assignSaving}>
                {assignSaving ? "Saving…" : "Save assignments"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={`Remove ${deleteTarget?.financialInstitution ?? "connection"}?`}
        confirmLabel="Remove connection"
        busy={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void handleDeleteToken(deleteTarget.id);
        }}
        body={
          <>
            <p>
              This also removes every account mapping for this connection and its entire
              reconciliation history — the staged transactions still waiting, and every row
              you have already matched, created or ignored.
            </p>
            <p>Transactions in your ledger are not deleted; they stop being linked to a bank record.</p>
          </>
        }
      />
    </div>
  );
}
