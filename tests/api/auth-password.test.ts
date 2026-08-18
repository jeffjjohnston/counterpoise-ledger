import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { books, sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { PUT } from "@/app/api/auth/password/route";
import { getSession } from "@/lib/session";
import { setupTestDatabase } from "@/tests/helpers/db-utils";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

describe("PUT /api/auth/password", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(sessions);
    await db.delete(books);
    await db.delete(users);
  });

  it("returns 401 when user is not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await PUT(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "old-password-123",
          newPassword: "new-password-123",
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Not authenticated",
    });
  });

  it("returns 401 when current password is incorrect", async () => {
    const passwordHash = await hashPassword("old-password-123");
    const [user] = await db
      .insert(users)
      .values({ username: "alice", passwordHash })
      .returning();

    vi.mocked(getSession).mockResolvedValue({ userId: user.id, sessionId: 1 });

    const response = await PUT(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "wrong-password-123",
          newPassword: "new-password-123",
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Current password is incorrect",
    });
  });

  it("updates the stored password hash when input is valid", async () => {
    const passwordHash = await hashPassword("old-password-123");
    const [user] = await db
      .insert(users)
      .values({ username: "alice", passwordHash })
      .returning();

    vi.mocked(getSession).mockResolvedValue({ userId: user.id, sessionId: 1 });

    const response = await PUT(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "old-password-123",
          newPassword: "new-password-123",
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    const [updatedUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id));

    expect(updatedUser).toBeDefined();
    expect(await verifyPassword("new-password-123", updatedUser!.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-123", updatedUser!.passwordHash)).toBe(false);
  });

  it("revokes the user's other sessions but keeps the one making the change", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [user] = await db
      .insert(users)
      .values({ username: "pw-user", passwordHash: await hashPassword("current-password-123") })
      .returning();

    const [current] = await db
      .insert(sessions)
      .values({ tokenHash: "current-session", userId: user.id, expiresAt })
      .returning();
    await db
      .insert(sessions)
      .values({ tokenHash: "a-phone-somewhere", userId: user.id, expiresAt });

    vi.mocked(getSession).mockResolvedValue({ userId: user.id, sessionId: current.id });

    const response = await PUT(
      new Request("http://localhost/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "current-password-123",
          newPassword: "new-password-123",
        }),
      })
    );
    expect(response.status).toBe(200);

    const remaining = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tokenHash).toBe("current-session");
  });
});
