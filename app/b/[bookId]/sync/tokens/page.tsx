"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { flattenAccounts } from "@/lib/accounting";
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
  const [form, setForm] = useState<NewTokenForm>(initialFormState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingToken, setEditingToken] = useState<PlaidTokenListItem | null>(null);
  const [editForm, setEditForm] = useState<EditTokenForm>(initialEditFormState);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedToken, setSelectedToken] = useState<PlaidTokenListItem | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountAssignment[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const accountOptions = useMemo(
    () => [
      { value: "", label: "None" },
      ...accounts
        .filter(
          (account) =>
            account.isActive &&
            (account.subtype === "bank" || account.subtype === "credit_card")
        )
        .map((account) => ({
          value: String(account.id),
          label: account.name,
        })),
    ],
    [accounts]
  );

  const fetchTokens = useCallback(async () => {
    const data = await apiGet<PlaidTokenListItem[]>(`/api/b/${bookId}/sync/tokens`);
    setTokens(Array.isArray(data) ? data : []);
  }, [bookId]);

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
        const message = toMessage(fetchError, "Failed to load sync token data");
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    // fetchInitialData already catches its own errors into `error`, so
    // this cannot reject.
    void fetchInitialData();
  }, [fetchAccounts, fetchTokens]);

  const handleAddToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await apiPost(`/api/b/${bookId}/sync/tokens`, form);
      setForm(initialFormState);
      await fetchTokens();
    } catch (submitError) {
      const message = toMessage(submitError, "Failed to add token");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteToken = async (tokenId: number) => {
    if (!confirm("Are you sure you want to delete this token?")) return;

    try {
      setError(null);
      await apiDelete(`/api/b/${bookId}/sync/tokens/${tokenId}`);
      await fetchTokens();
    } catch (deleteError) {
      const message = toMessage(deleteError, "Failed to delete token");
      setError(message);
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
      const message = toMessage(saveError, "Failed to update token");
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
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Manage Sync Tokens</h1>
        <Button variant="secondary" onClick={() => router.push(`/b/${bookId}/sync`)}>
          Back to Sync
        </Button>
      </div>

      <div className="bg-surface rounded-lg border border-border p-6 mb-6">
        <h2 className="text-lg font-semibold text-fg mb-4">Add Token</h2>
        <form className="grid grid-cols-1 md:grid-cols-3 gap-4" onSubmit={handleAddToken}>
          <Input
            id="financialInstitution"
            label="Financial Institution"
            value={form.financialInstitution}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                financialInstitution: event.target.value,
              }))
            }
          />
          <Input
            id="itemId"
            label="Item ID"
            value={form.itemId}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, itemId: event.target.value }))
            }
          />
          <Input
            id="accessToken"
            label="Access Token"
            type="password"
            value={form.accessToken}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, accessToken: event.target.value }))
            }
          />
          <div className="md:col-span-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding..." : "Add Token"}
            </Button>
          </div>
        </form>
      </div>

      {error && (
        <div className="mb-4 bg-danger-subtle border border-border rounded-lg p-4 text-sm text-fg-danger">
          {error}
        </div>
      )}

      {tokens.length === 0 ? (
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          No tokens configured yet.
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-border overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider bg-surface-secondary">
                <th className="px-4 py-3">Financial Institution</th>
                <th className="px-4 py-3">Item ID</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td className="px-4 py-3 text-sm text-fg">
                    {token.financialInstitution}
                  </td>
                  <td className="px-4 py-3 text-sm text-fg-secondary">{token.itemId}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleOpenEditModal(token)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleOpenAssignModal(token)}
                      >
                        Assign Accounts
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDeleteToken(token.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={showEditModal}
        onClose={closeEditModal}
        title="Edit Token"
      >
        <form className="space-y-4" onSubmit={handleSaveEditedToken}>
          <Input
            id="edit-financialInstitution"
            label="Financial Institution"
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
              label="New Access Token"
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
              {editSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={showAssignModal}
        onClose={closeAssignModal}
        title={`Assign Accounts${selectedToken ? ` - ${selectedToken.financialInstitution}` : ""}`}
        size="lg"
      >
        {assignLoading ? (
          <p className="text-sm text-fg-secondary">Refreshing accounts from Plaid...</p>
        ) : assignError ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-danger">{assignError}</p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={closeAssignModal}>
                Close
              </Button>
            </div>
          </div>
        ) : plaidAccounts.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              No Plaid accounts were returned for this token.
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
                  <Select
                    id={`assignment-${plaidAccount.plaidAccountId}`}
                    label="Counterpoise Account"
                    value={
                      plaidAccount.counterpoiseAccountId !== null
                        ? String(plaidAccount.counterpoiseAccountId)
                        : ""
                    }
                    options={accountOptions}
                    onChange={(event) =>
                      handleAssignmentChange(
                        plaidAccount.plaidAccountId,
                        event.target.value
                      )
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeAssignModal}>
                Cancel
              </Button>
              <Button onClick={handleSaveAssignments} disabled={assignSaving}>
                {assignSaving ? "Saving..." : "Save Assignments"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
