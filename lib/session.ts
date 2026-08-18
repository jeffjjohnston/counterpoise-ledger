import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { eq, and, gt, lt } from "drizzle-orm";
import { generateSessionToken } from "./auth";

const COOKIE_NAME = "counterpoise_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// No salt: the token is 256 bits of CSPRNG output, so there is no dictionary
// or rainbow-table exposure to salt against. The cookie holds the plaintext;
// only its digest is ever written to the database, and therefore to backups.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Origins browsers treat as "potentially trustworthy" (W3C secure contexts),
 * where a Secure cookie is still stored even over plain HTTP. This exemption
 * is why running on http://localhost works and http://<lan-ip> does not.
 */
const TRUSTWORTHY_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Drops the port, leaving an IPv6 literal's own colons intact. */
function hostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

/**
 * True when the cookie being set is one the browser will silently discard.
 *
 * A Secure cookie delivered over plain HTTP to anything but localhost is
 * dropped, so login returns 200 and then bounces straight back to the login
 * page — indistinguishable from a wrong password. Compose's APP_BIND=0.0.0.0
 * is exactly the configuration that produces it.
 *
 * A proxy that forwards HTTPS without setting x-forwarded-proto yields a false
 * positive here, which costs nothing: the caller logs, it never blocks.
 */
export function shouldWarnInsecureCookie({
  secure,
  forwardedProto,
  host,
}: {
  secure: boolean;
  forwardedProto: string | null;
  host: string | null;
}): boolean {
  // Not Secure means plain HTTP works, which is the development default.
  if (!secure) return false;
  // Nothing to judge. Staying quiet beats guessing.
  if (!host) return false;
  // Chained proxies append, so the client-facing hop is the first value.
  if (forwardedProto?.split(",")[0].trim().toLowerCase() === "https") return false;

  return !TRUSTWORTHY_HOSTS.has(hostname(host));
}

export async function createSession(userId: number): Promise<string> {
  const db = getDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // Opportunistic, not a guarantee: a user who never logs in again leaves rows
  // behind. Login is infrequent and already writes, whereas getSession() runs on
  // every request.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));

  await db.insert(sessions)
    .values({ tokenHash: hashToken(token), userId, expiresAt });

  const secure = process.env.NODE_ENV === "production";

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  });

  // Logged here, at the moment the doomed cookie is set, rather than at
  // startup: the process cannot see APP_BIND (Compose uses it for the port
  // mapping, not the container environment), and binding to 0.0.0.0 would not
  // prove there is no TLS proxy anyway. This fires exactly when the failure
  // does, and every time, so it is still in the log when someone goes looking.
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (
    shouldWarnInsecureCookie({
      secure,
      forwardedProto: requestHeaders.get("x-forwarded-proto"),
      host,
    })
  ) {
    console.warn(
      `[counterpoise] The session cookie is marked Secure, but this request arrived over ` +
        `plain HTTP at ${host}. Browsers discard Secure cookies on non-localhost HTTP ` +
        `origins, so login will appear to succeed and then return to the login page. Put a ` +
        `TLS proxy in front — see "Getting HTTPS" in README.md.`
    );
  }

  return token;
}

export async function getSession(): Promise<{ userId: number; sessionId: number } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const db = getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));

  if (!session) return null;

  return { userId: session.userId, sessionId: session.id };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (token) {
    const db = getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  cookieStore.delete(COOKIE_NAME);
}

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}
