import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares digests rather than the raw values: timingSafeEqual throws when its
 * arguments differ in length, and catching that would itself leak length.
 * SHA-256 makes both sides 32 bytes, so the comparison is total.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function verifyCronSecret(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  return timingSafeEqual(digest(authHeader), digest(`Bearer ${cronSecret}`));
}
