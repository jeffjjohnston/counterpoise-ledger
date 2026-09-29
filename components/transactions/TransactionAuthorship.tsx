"use client";

import { useBookRole } from "@/components/BookRoleProvider";

/** "Added by … · Last changed by …". Shows only in a book with more than one member. */
export function TransactionAuthorship({
  createdBy,
  updatedBy,
}: {
  createdBy: number | null | undefined;
  updatedBy: number | null | undefined;
}) {
  const { members } = useBookRole();
  if (members.length < 2) return null;

  const name = (id: number | null | undefined) =>
    id == null ? "System" : members.find((m) => m.userId === id)?.username ?? "Former member";

  return (
    <p className="text-xs text-fg-tertiary">
      {`Added by ${name(createdBy)} · Last changed by ${name(updatedBy ?? createdBy)}`}
    </p>
  );
}
