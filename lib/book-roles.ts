// Roles and access levels for shared books. This module has no server
// imports: client components use it to decide which controls to show. The
// server enforces the same rules in rust-api/server/src/book_auth.rs.

export const BOOK_ROLES = ["owner", "editor", "viewer"] as const;
export type BookRole = (typeof BOOK_ROLES)[number];

/**
 * What an operation needs. `read` accepts every role, `write` accepts owner
 * and editor, `owner` accepts owner only.
 */
export type AccessLevel = "read" | "write" | "owner";

const ALLOWED: Record<AccessLevel, readonly BookRole[]> = {
  read: BOOK_ROLES,
  write: ["owner", "editor"],
  owner: ["owner"],
};

export function roleSatisfies(role: BookRole, level: AccessLevel): boolean {
  return ALLOWED[level].includes(role);
}

/** The message a member gets when their role is below the level. */
export function accessDeniedMessage(level: AccessLevel): string {
  return level === "owner" ? "Only an owner can do this" : "You have read-only access to this book";
}
