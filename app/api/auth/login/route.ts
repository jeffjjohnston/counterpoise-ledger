import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { createSession } from "@/lib/session";
import {
  checkRateLimit,
  clientIpFrom,
  recordFailure,
  recordSuccess,
} from "@/lib/rate-limit";
import { loginSchema, type LoginInput } from "@/lib/schemas/auth";

/**
 * Compared against when the username does not exist, so an unknown account
 * costs the same ~50ms of scrypt as a real one. Belt-and-braces: registration
 * still answers "Username already taken", so rate limiting is what actually
 * makes enumeration expensive.
 */
let dummyHash: Promise<string> | null = null;
function invalidPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("counterpoise-no-such-account");
  return dummyHash;
}

export async function POST(request: Request) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    // loginSchema's superRefine guarantees both fields are non-empty strings
    // by the time safeParse succeeds — see lib/schemas/auth.ts.
    const { username, password } = parsed.data as LoginInput;

    // Before the limiter: it lowercases the username to build a key, so a
    // non-string reaching it throws and the route answers 500 rather than 400.
    // (loginSchema above already guarantees username is a string.)
    const keys = { username, ip: clientIpFrom(request) };

    const verdict = checkRateLimit("login", keys);
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
      .select()
      .from(users)
      .where(eq(users.username, username));

    if (!user) {
      await verifyPassword(password, await invalidPasswordHash());
      recordFailure("login", keys);
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      recordFailure("login", keys);
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    await createSession(user.id);
    // After the session exists, so the bucket clears on a completed login
    // rather than merely a correct password.
    recordSuccess("login", keys);

    return NextResponse.json({
      id: user.id,
      username: user.username,
    });
  } catch (error) {
    console.error("Error logging in:", error);
    return NextResponse.json(
      { error: "Failed to log in" },
      { status: 500 }
    );
  }
}
