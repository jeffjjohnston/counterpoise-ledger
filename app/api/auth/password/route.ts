import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { getSession } from "@/lib/session";
import {
  checkRateLimit,
  clientIpFrom,
  recordFailure,
  recordSuccess,
} from "@/lib/rate-limit";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/schemas/auth";

export async function PUT(request: Request) {
  try {
    const parsed = changePasswordSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    // changePasswordSchema's superRefine guarantees both fields are
    // distinct strings meeting the length policy by the time safeParse
    // succeeds — see lib/schemas/auth.ts.
    const { currentPassword, newPassword } = parsed.data as ChangePasswordInput;

    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Keyed on the session's user id rather than anything client-supplied, so
    // the bucket cannot be sidestepped by varying a field in the payload.
    const keys = { username: `uid:${session.userId}`, ip: clientIpFrom(request) };

    const verdict = checkRateLimit("password", keys);
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${verdict.retryAfterSeconds}s.` },
        {
          status: 429,
          headers: { "Retry-After": String(verdict.retryAfterSeconds) },
        }
      );
    }

    const db = getDb();
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.userId));

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      recordFailure("password", keys);
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 }
      );
    }

    recordSuccess("password", keys);

    // Revoke sibling sessions first, keeping the one that made the change —
    // being logged out of the device you just used to change your password is
    // a usability bug, not a security one. Doing this before the hash update
    // is fail-secure: if the update below throws, the user's other sessions
    // are already gone but the password is unchanged, rather than the reverse
    // (password changed, old sessions still live).
    await db.delete(sessions).where(
      and(eq(sessions.userId, session.userId), ne(sessions.id, session.sessionId))
    );

    const nextPasswordHash = await hashPassword(newPassword);
    await db.update(users)
      .set({ passwordHash: nextPasswordHash })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating password:", error);
    return NextResponse.json(
      { error: "Failed to update password" },
      { status: 500 }
    );
  }
}
