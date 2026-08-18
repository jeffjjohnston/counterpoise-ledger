import { getDb } from "@/db";
import { apiKeys, books } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyApiKey } from "@/lib/api-keys";

export type McpAuth = {
  userId: number;
  keyId: number;
};

let cachedAuth: McpAuth | null = null;
let lastRevalidation = 0;
const REVALIDATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validate the COUNTERPOISE_API_KEY env var against the database.
 * Returns the authenticated user context or null if no key / invalid key.
 * Caches the result for the lifetime of the process.
 *
 * Uses keyPrefix to narrow candidates before expensive scrypt verification.
 */
export async function initMcpAuth(): Promise<McpAuth | null> {
  const apiKey = process.env.COUNTERPOISE_API_KEY;
  if (!apiKey) return null;

  const prefix = apiKey.slice(0, 8);
  const db = getDb();
  const candidates = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, keyHash: apiKeys.keyHash })
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix));

  for (const row of candidates) {
    if (await verifyApiKey(apiKey, row.keyHash)) {
      // Update last used timestamp
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id));

      cachedAuth = { userId: row.userId, keyId: row.id };
      return cachedAuth;
    }
  }

  return null;
}

/**
 * Get the cached MCP auth context. Returns null if no valid key was provided.
 */
export function getMcpAuth(): McpAuth | null {
  return cachedAuth;
}

/**
 * Verify the authenticated user has access to a specific book.
 * Returns true if the book belongs to the user, false otherwise.
 */
export async function verifyBookAccess(
  auth: McpAuth,
  bookId: number
): Promise<boolean> {
  const db = getDb();
  const [book] = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.userId, auth.userId)));
  return !!book;
}

// ── MCP tool response helpers ────────────────────────────────────────────────

type McpErrorResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

export function authError(): McpErrorResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: "A valid COUNTERPOISE_API_KEY is required" }) }],
    isError: true,
  };
}

export function bookAccessError(): McpErrorResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: "You do not have access to this book" }) }],
    isError: true,
  };
}

/**
 * Require authentication. Returns the auth context or an MCP error response.
 * Periodically re-checks that the key still exists in the database so that
 * revoked keys stop working without a process restart.
 */
export async function requireAuth(): Promise<McpAuth | McpErrorResponse> {
  const auth = getMcpAuth();
  if (!auth) return authError();

  const now = Date.now();
  if (now - lastRevalidation > REVALIDATION_INTERVAL_MS) {
    const db = getDb();
    const [row] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.id, auth.keyId));
    if (!row) {
      cachedAuth = null;
      return authError();
    }
    lastRevalidation = now;
  }

  return auth;
}

/**
 * Require authentication and book access. Returns the auth context or an MCP error response.
 */
export async function requireBookAuth(
  bookId: number
): Promise<McpAuth | McpErrorResponse> {
  const result = await requireAuth();
  if ("isError" in result) return result;
  if (!(await verifyBookAccess(result, bookId))) return bookAccessError();
  return result;
}
