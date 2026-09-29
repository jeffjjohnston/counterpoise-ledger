"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "@/lib/navigation";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { useBookRole, type BookMemberSummary } from "@/components/BookRoleProvider";
import { apiDelete, apiPost, apiPut, toMessage } from "@/lib/api-client";
import { BOOK_ROLES, type BookRole } from "@/lib/book-roles";

const roleLabel = (role: BookRole) => role[0].toUpperCase() + role.slice(1);

const ROLE_OPTIONS = BOOK_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));

/** A members change that waits for the user to confirm it. */
type PendingChange =
  | { kind: "remove"; member: BookMemberSummary }
  | { kind: "role"; member: BookMemberSummary; role: BookRole }
  | { kind: "leave" };

export function BookMembersSettings({ bookId }: { bookId: string }) {
  const { members, isOwner, currentUserId, refresh } = useBookRole();
  const toast = useToast();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [newRole, setNewRole] = useState<BookRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      refresh();
    } catch (e) {
      toast.error(toMessage(e, "Could not change the members"));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const changeRole = (member: BookMemberSummary, role: BookRole) =>
    run(() => apiPut(`/api/books/${bookId}/members/${member.userId}`, { role }), "Role changed");

  // A change between editor and viewer for another member is one step. It is
  // easy to undo. A change that removes an owner, gives owner access, or
  // changes your own access asks first: you can lose access that you cannot
  // get back alone.
  const requestRoleChange = (member: BookMemberSummary, role: BookRole) => {
    if (role === member.role) return;
    const needsConfirm = member.role === "owner" || role === "owner" || member.userId === currentUserId;
    if (needsConfirm) setPending({ kind: "role", member, role });
    else void changeRole(member, role);
  };

  const add = () =>
    run(async () => {
      await apiPost(`/api/books/${bookId}/members`, { username: username.trim(), role: newRole });
      setUsername("");
    }, "Member added");

  // A sole owner cannot leave: the book would keep no owner. Any other role
  // can always leave — the server enforces the same rule on delete.
  const canLeave = !isOwner || members.filter((m) => m.role === "owner").length > 1;

  const leave = async () => {
    if (currentUserId === null) {
      // The current user did not load, so there is no member id to remove.
      setPending(null);
      toast.error("Could not leave the book. Reload the page and try again.");
      return;
    }
    setBusy(true);
    try {
      await apiDelete(`/api/books/${bookId}/members/${currentUserId}`);
      router.push("/");
    } catch (e) {
      toast.error(toMessage(e, "Could not leave the book"));
      setBusy(false);
      setPending(null);
    }
  };

  const confirmPending = () => {
    switch (pending?.kind) {
      case "leave":
        void leave();
        break;
      case "remove": {
        const { member } = pending;
        void run(() => apiDelete(`/api/books/${bookId}/members/${member.userId}`), "Member removed");
        break;
      }
      case "role":
        void changeRole(pending.member, pending.role);
        break;
    }
  };

  const dialog = describePending(pending, currentUserId);

  return (
    <section className="pt-4 border-t border-border">
      <h3 className="text-sm font-semibold text-fg">Members</h3>
      <ul className="mt-2 space-y-2">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-fg">
              {member.username}
              {member.userId === currentUserId && <span className="text-fg-tertiary"> (you)</span>}
            </span>
            {isOwner ? (
              <span className="flex items-center gap-2">
                <Select
                  id={`member-role-${member.userId}`}
                  aria-label={`Role for ${member.username}`}
                  value={member.role}
                  disabled={busy}
                  onChange={(e) => requestRoleChange(member, e.target.value as BookRole)}
                  options={ROLE_OPTIONS}
                />
                {member.userId !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPending({ kind: "remove", member })}
                  >
                    Remove
                  </Button>
                )}
              </span>
            ) : (
              <span className="text-fg-tertiary capitalize">{member.role}</span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (username.trim()) void add(); }}
        >
          <Input id="new-member-username" label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Select
            id="new-member-role"
            aria-label="New member role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as BookRole)}
            options={ROLE_OPTIONS}
          />
          <Button type="submit" size="sm" disabled={busy || !username.trim()}>Add member</Button>
        </form>
      )}

      {canLeave && (
        <Button variant="secondary" size="sm" className="mt-3" disabled={busy} onClick={() => setPending({ kind: "leave" })}>
          Leave book
        </Button>
      )}

      {dialog && (
        <ConfirmModal
          isOpen
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          busy={busy}
          onConfirm={confirmPending}
          onClose={() => { if (!busy) setPending(null); }}
        />
      )}
    </section>
  );
}

/** The words of the confirm step for a pending change. */
function describePending(
  pending: PendingChange | null,
  currentUserId: number | null
): { title: string; body: ReactNode; confirmLabel: string } | null {
  if (pending === null) return null;

  if (pending.kind === "leave") {
    return {
      title: "Leave this book?",
      body: <p>You lose access to this book. Only an owner can add you again.</p>,
      confirmLabel: "Leave",
    };
  }

  const { member } = pending;
  if (pending.kind === "remove") {
    return {
      title: `Remove ${member.username}?`,
      body: <p>{member.username} loses access to this book. An owner can add them again.</p>,
      confirmLabel: "Remove member",
    };
  }

  const isSelf = member.userId === currentUserId;
  const change = `${roleLabel(member.role)} to ${roleLabel(pending.role)}`;
  let consequence: string;
  if (pending.role === "owner") {
    consequence = "An owner can change the role of each member, remove each member, and delete the book.";
  } else if (isSelf) {
    consequence = "You lose owner access. Only an owner can give it back to you.";
  } else {
    consequence = `${member.username} loses owner access. Only an owner can give it back.`;
  }
  return {
    title: isSelf ? "Change your own role?" : `Change the role of ${member.username}?`,
    body: (
      <>
        <p>{isSelf ? `Your role changes from ${change}.` : `The role of ${member.username} changes from ${change}.`}</p>
        <p>{consequence}</p>
      </>
    ),
    confirmLabel: "Change role",
  };
}
