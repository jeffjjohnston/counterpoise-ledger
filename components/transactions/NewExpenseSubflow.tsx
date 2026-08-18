"use client";

import { useBookId } from "@/hooks/useBookId";
import { apiPost, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import type { AccountWithBalance } from "@/types";

// Renders the "+ New Expense Account" mini-form shared by TransactionForm's
// compact and desktop layouts. Both call sites render this component
// unconditionally; it returns null when `isOpen` is false.
//
// The two layouts differ only presentationally, driven by `compact`:
//   - the outer container's padding/spacing ("p-3 space-y-2" vs "p-4
//     space-y-3")
//   - the Name and Parent Expense fields' `size` ("compact" vs the default)
// A line-by-line diff of both original blocks (compact at TransactionForm.tsx
// ~970-1027, desktop at ~1237-1292, as of commit 889b30e) turned up nothing
// else — no structural, behavioural, or textual difference beyond those two,
// aside from one code comment being word-wrapped differently across two
// lines with identical text, which carries no observable difference either
// way.
//
// The draft name/parent and the in-flight "creating" guard are controlled by
// the parent (TransactionForm) rather than owned here. Both call sites live
// inside mode conditionals, so this component unmounts on a mode switch —
// state kept locally here would be destroyed along with it, silently
// re-enabling the Create button mid-request and losing whatever the user had
// typed. Lifting the state to the parent, which survives the mode switch,
// restores the pre-extraction behaviour.
export function NewExpenseSubflow({
  accounts,
  isOpen,
  onToggle,
  onCreated,
  compact,
  name,
  onNameChange,
  parentId,
  onParentIdChange,
  isCreating,
  onCreatingChange,
}: {
  accounts: AccountWithBalance[];
  isOpen: boolean;
  onToggle: () => void;
  onCreated: (accountId: number) => void;
  compact: boolean;
  name: string;
  onNameChange: (value: string) => void;
  parentId: number | null;
  onParentIdChange: (id: number | null) => void;
  isCreating: boolean;
  onCreatingChange: (value: boolean) => void;
}) {
  const bookId = useBookId();
  const toast = useToast();

  if (!isOpen) return null;

  const handleCreateExpense = async () => {
    if (!name.trim()) {
      toast.error("Please enter an expense name");
      return;
    }

    onCreatingChange(true);
    try {
      const newAccount = await apiPost<{ id: number }>(`/api/b/${bookId}/accounts`, {
        name,
        type: "expense",
        parentId,
      });
      onNameChange("");
      onParentIdChange(null);
      onToggle();
      onCreated(newAccount.id);
    } catch (error) {
      console.error("Failed to create expense account", error);
      toast.error(toMessage(error, "Failed to create expense account"));
    } finally {
      onCreatingChange(false);
    }
  };

  return (
    <div
      className={`bg-surface-secondary border border-border rounded-lg ${
        compact ? "p-3 space-y-2" : "p-4 space-y-3"
      }`}
    >
      <div className="grid grid-cols-2 gap-3">
        <Input
          type="text"
          label="New Expense Name"
          id="newExpense"
          size={compact ? "compact" : undefined}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g., Coffee, Gas, Utilities"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // handleCreateExpense already catches its own errors
              // in a try/finally; it cannot reject.
              void handleCreateExpense();
            } else if (e.key === "Escape") {
              onToggle();
              onNameChange("");
              onParentIdChange(null);
            }
          }}
        />
        <AccountAutocomplete
          label="Parent Expense (optional)"
          accounts={accounts.filter((a) => a.type === "expense")}
          value={parentId}
          onChange={(id) => onParentIdChange(id)}
          placeholder="No parent (top level)"
          showHierarchy={true}
          size={compact ? "compact" : undefined}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            onToggle();
            onNameChange("");
            onParentIdChange(null);
          }}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleCreateExpense}
          disabled={isCreating}
        >
          {isCreating ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}
