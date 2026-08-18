import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { createSession } from "@/lib/session";
import { isRegistrationOpen, REGISTRATION_LOCK_ID } from "@/lib/registration";
import { checkRateLimit, clientIpFrom, recordFailure } from "@/lib/rate-limit";
import { registerSchema, type RegisterInput } from "@/lib/schemas/auth";

export async function POST(request: Request) {
  try {
    const parsed = registerSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    // registerSchema's superRefine guarantees both fields are strings
    // meeting the length policy by the time safeParse succeeds — see
    // lib/schemas/auth.ts, including the note on this schema's shape
    // validation now running before the registration-open gate below
    // (previously, an out-of-policy username/password sent while
    // registration was closed got 403 here without ever reaching the
    // length checks; it now gets 400 first).
    const { username, password } = parsed.data as RegisterInput;

    if (!(await isRegistrationOpen())) {
      return NextResponse.json(
        { error: "Registration is closed" },
        { status: 403 }
      );
    }

    // Before the limiter: it lowercases the username to build a key, so a
    // non-string reaching it throws and the route answers 500 rather than 400.
    // (registerSchema above already guarantees username is a string.)
    const keys = { username, ip: clientIpFrom(request) };

    const verdict = checkRateLimit("register", keys);
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${verdict.retryAfterSeconds}s.` },
        {
          status: 429,
          headers: { "Retry-After": String(verdict.retryAfterSeconds) },
        }
      );
    }

    // Hashed outside the transaction: ~50ms is a long time to hold a global
    // lock, and the work is wasted only on the rare losing path.
    const passwordHash = await hashPassword(password);

    const db = getDb();

    // The zero-user check and the insert have to be one atomic step. Without
    // the lock, two concurrent requests against a fresh instance both count
    // zero users, both hash, and both insert — letting anyone who can reach a
    // new deployment create an account alongside its owner.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${REGISTRATION_LOCK_ID})`);

      if (!(await isRegistrationOpen(tx))) return { kind: "closed" as const };

      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.username, username));

      if (existing) return { kind: "taken" as const };

      const [created] = await tx
        .insert(users)
        .values({ username, passwordHash })
        .returning();

      return { kind: "created" as const, user: created };
    });

    if (outcome.kind === "closed") {
      return NextResponse.json(
        { error: "Registration is closed" },
        { status: 403 }
      );
    }

    if (outcome.kind === "taken") {
      // Counts against the limit so enumeration through this message is itself
      // throttled — the message is kept deliberately, and rate limiting is what
      // makes probing it expensive.
      recordFailure("register", keys);
      return NextResponse.json(
        { error: "Username already taken" },
        { status: 409 }
      );
    }

    const user = outcome.user;

    await createSession(user.id);

    return NextResponse.json({
      id: user.id,
      username: user.username,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    return NextResponse.json(
      { error: "Failed to register" },
      { status: 500 }
    );
  }
}
