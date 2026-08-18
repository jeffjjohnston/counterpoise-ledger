export type RateLimitScope = "login" | "register" | "password";

export type RateLimitKeys = {
  username?: string | null;
  ip?: string | null;
};

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const WINDOW_MS = 15 * 60_000;
const USERNAME_LIMIT = 5;
const IP_LIMIT = 20;

/** Consecutive lockouts escalate through these, then stay at the last. */
const LOCKOUT_STEPS_MS = [60_000, 120_000, 240_000, 480_000, 900_000];

/**
 * Keys are attacker-chosen (any username can be attempted), so an unbounded
 * map is a memory-exhaustion vector. Ten thousand is far past any household's
 * real footprint and trivially small in memory, so the cap can only be reached
 * by abuse.
 */
const MAX_ENTRIES = 10_000;

/**
 * Sweeping evicts down to here rather than just back under the cap. Without
 * the headroom, a flood sits exactly at the cap and every subsequent write
 * triggers a full sweep and sort — O(n) per request precisely when under
 * attack. With it, a sweep buys a thousand writes.
 */
const EVICT_TO = 9_000;

type Entry = {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
  consecutiveLockouts: number;
};

/**
 * Usernames are attacker-supplied and unbounded — nothing in the schema or the
 * routes caps their length. Capping the entry *count* alone would still allow
 * ten thousand multi-megabyte keys, which is the same memory exhaustion by
 * another route. Truncating collides long shared prefixes into one bucket,
 * which throttles more rather than less: the safe direction for a collision.
 */
const MAX_KEY_CHARS = 64;

function userKey(scope: RateLimitScope, username: string): string {
  return `user:${scope}:${username.toLowerCase().slice(0, MAX_KEY_CHARS)}`;
}

const entries = new Map<string, Entry>();

/**
 * Sweeping the whole map on every failed attempt is O(n) per request, which at
 * the cap means ten thousand comparisons to record one bad password. Expiry is
 * therefore decided per-key at lookup, and the sweep runs only to reclaim
 * memory — amortised across writes, or immediately when the cap is in reach.
 */
const SWEEP_EVERY = 512;
let writesSinceSweep = 0;

function bucketsFor(
  scope: RateLimitScope,
  keys: RateLimitKeys
): Array<{ key: string; limit: number }> {
  const buckets: Array<{ key: string; limit: number }> = [];
  if (keys.username) {
    buckets.push({ key: userKey(scope, keys.username), limit: USERNAME_LIMIT });
  }
  if (keys.ip) {
    buckets.push({
      key: `ip:${scope}:${keys.ip.slice(0, MAX_KEY_CHARS)}`,
      limit: IP_LIMIT,
    });
  }
  return buckets;
}

function expiryOf(entry: Entry): number {
  return Math.max(entry.windowStartedAt + WINDOW_MS, entry.lockedUntil);
}

/** The entry for this key if it is still meaningful, else undefined. */
function liveEntry(key: string, now: number): Entry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  // A fully expired entry is treated as absent, which is what lets the lockout
  // escalation decay after a long quiet period rather than punishing someone
  // for months-old fumbles.
  return expiryOf(entry) > now ? entry : undefined;
}

function sweep(now: number): void {
  for (const [key, entry] of entries) {
    if (expiryOf(entry) <= now) entries.delete(key);
  }

  if (entries.size <= MAX_ENTRIES) return;

  // Unlocked entries go first, and only then by expiry.
  //
  // Sorting by expiry alone does NOT protect active lockouts, despite looking
  // like it should: every lockout step is shorter than the window, so
  // expiryOf() returns windowStartedAt + WINDOW_MS for locked and unlocked
  // entries alike. They tie, a stable sort falls back to insertion order, and
  // the pre-existing lockout — created before the flood — is evicted first.
  //
  // That turns the cap into the bypass: get locked out, flood the map with
  // distinct usernames until your own entry is evicted, resume immediately.
  //
  // If every entry is locked there is nothing safe left to drop and the
  // soonest-expiring lockout goes. Reaching that state needs five failures
  // against each of ten thousand usernames, which the IP bucket throttles long
  // before it gets there.
  const byEvictability = [...entries.entries()].sort((a, b) => {
    const aLocked = a[1].lockedUntil > now ? 1 : 0;
    const bLocked = b[1].lockedUntil > now ? 1 : 0;
    if (aLocked !== bLocked) return aLocked - bLocked;
    return expiryOf(a[1]) - expiryOf(b[1]);
  });
  for (const [key] of byEvictability.slice(0, entries.size - EVICT_TO)) {
    entries.delete(key);
  }
}

function maybeSweep(now: number): void {
  writesSinceSweep += 1;
  if (writesSinceSweep >= SWEEP_EVERY || entries.size >= MAX_ENTRIES) {
    writesSinceSweep = 0;
    sweep(now);
  }
}

export function checkRateLimit(
  scope: RateLimitScope,
  keys: RateLimitKeys,
  now: number = Date.now()
): RateLimitVerdict {
  for (const { key } of bucketsFor(scope, keys)) {
    const entry = entries.get(key);
    if (entry && entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      };
    }
  }
  return { allowed: true };
}

export function recordFailure(
  scope: RateLimitScope,
  keys: RateLimitKeys,
  now: number = Date.now()
): void {
  for (const { key, limit } of bucketsFor(scope, keys)) {
    const existing = liveEntry(key, now);
    const windowLive = existing && existing.windowStartedAt + WINDOW_MS > now;

    const entry: Entry = windowLive
      ? existing
      : {
          failures: 0,
          windowStartedAt: now,
          lockedUntil: 0,
          // Preserved across a lapsed window so repeat offenders keep
          // escalating. liveEntry() returns undefined once the entry has fully
          // expired, which is how the escalation eventually decays.
          consecutiveLockouts: existing?.consecutiveLockouts ?? 0,
        };

    entry.failures += 1;

    if (entry.failures >= limit) {
      const step =
        LOCKOUT_STEPS_MS[
          Math.min(entry.consecutiveLockouts, LOCKOUT_STEPS_MS.length - 1)
        ];
      entry.lockedUntil = now + step;
      entry.consecutiveLockouts += 1;
      entry.failures = 0;
      entry.windowStartedAt = now;
    }

    entries.set(key, entry);
  }

  // After the writes, so the cap is an invariant that holds on return rather
  // than one the next call happens to restore.
  maybeSweep(now);
}

export function recordSuccess(
  scope: RateLimitScope,
  keys: RateLimitKeys,
  now: number = Date.now()
): void {
  maybeSweep(now);
  // Username bucket only. Clearing the IP bucket would let anyone holding a
  // single valid account reset their own IP limit at will.
  // Same key derivation as bucketsFor, via userKey, so the two cannot drift
  // apart and leave a bucket uncleared.
  if (keys.username) {
    entries.delete(userKey(scope, keys.username));
  }
}

/**
 * Rightmost entry: the address the trusted proxy appended. The leftmost is
 * whatever the client claimed and is forgeable.
 */
export function clientIpFrom(request: Request): string | null {
  const header = request.headers.get("x-forwarded-for");
  if (!header) return null;
  const parts = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? null;
}

/** Test-only helpers. */
export function __resetRateLimits(): void {
  entries.clear();
  writesSinceSweep = 0;
}

/**
 * Sweeps at the given instant before reporting, so the count reflects entries
 * actually still held rather than whatever the amortised sweep last left
 * behind. Takes `now` explicitly because the tests operate on a fixed clock.
 */
export function __rateLimitSize(now: number = Date.now()): number {
  sweep(now);
  return entries.size;
}
export function __rateLimitKeys(): string[] {
  return [...entries.keys()];
}
