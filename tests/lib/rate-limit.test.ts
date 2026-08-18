import { beforeEach, describe, expect, it } from "vitest";
import {
  __rateLimitSize,
  __resetRateLimits,
  checkRateLimit,
  clientIpFrom,
  recordFailure,
  recordSuccess,
} from "@/lib/rate-limit";

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

beforeEach(() => __resetRateLimits());

function failTimes(n: number, keys: { username?: string; ip?: string }, at = T0) {
  for (let i = 0; i < n; i++) recordFailure("login", keys, at);
}

describe("rate limit policy", () => {
  it("allows attempts below the username limit", () => {
    failTimes(4, { username: "alice" });

    expect(checkRateLimit("login", { username: "alice" }, T0)).toEqual({
      allowed: true,
    });
  });

  it("blocks at the username limit with a Retry-After", () => {
    failTimes(5, { username: "alice" });

    const verdict = checkRateLimit("login", { username: "alice" }, T0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSeconds).toBe(60);
  });

  it("keys usernames case-insensitively", () => {
    failTimes(5, { username: "Alice" });

    expect(checkRateLimit("login", { username: "alice" }, T0).allowed).toBe(false);
  });

  it("isolates scopes from each other", () => {
    failTimes(5, { username: "alice" });

    expect(checkRateLimit("password", { username: "alice" }, T0).allowed).toBe(true);
  });

  it("allows a far more permissive IP budget than username budget", () => {
    for (let i = 0; i < 19; i++) {
      recordFailure("login", { username: `user${i}`, ip: "100.64.0.7" }, T0);
    }

    expect(checkRateLimit("login", { ip: "100.64.0.7" }, T0).allowed).toBe(true);

    recordFailure("login", { username: "user19", ip: "100.64.0.7" }, T0);
    expect(checkRateLimit("login", { ip: "100.64.0.7" }, T0).allowed).toBe(false);
  });

  it("releases the lock once it expires", () => {
    failTimes(5, { username: "alice" });

    expect(checkRateLimit("login", { username: "alice" }, T0 + 61_000).allowed).toBe(
      true
    );
  });

  it("escalates the lockout on each consecutive trip", () => {
    failTimes(5, { username: "alice" }, T0);
    const first = checkRateLimit("login", { username: "alice" }, T0);
    expect(first.allowed === false && first.retryAfterSeconds).toBe(60);

    const later = T0 + 2 * MINUTE;
    failTimes(5, { username: "alice" }, later);
    const second = checkRateLimit("login", { username: "alice" }, later);
    expect(second.allowed === false && second.retryAfterSeconds).toBe(120);
  });

  it("caps the escalation at fifteen minutes", () => {
    // Each wait clears the current lock while staying inside the 15-minute
    // window, so the entry survives and the escalation accumulates. Waiting
    // longer than the window would prune the entry and reset the escalation —
    // which is the intended decay, exercised by the next test.
    let at = T0;
    for (const wait of [61_000, 121_000, 241_000, 481_000]) {
      failTimes(5, { username: "alice" }, at);
      at += wait;
    }

    failTimes(5, { username: "alice" }, at);
    const verdict = checkRateLimit("login", { username: "alice" }, at);
    expect(verdict.allowed === false && verdict.retryAfterSeconds).toBe(900);
  });

  it("decays the escalation after a long quiet period", () => {
    failTimes(5, { username: "alice" }, T0);

    // Past the entry's expiry, so it is pruned and the next lockout starts
    // back at one minute rather than punishing a user for months-old fumbles.
    const muchLater = T0 + 20 * MINUTE;
    failTimes(5, { username: "alice" }, muchLater);

    const verdict = checkRateLimit("login", { username: "alice" }, muchLater);
    expect(verdict.allowed === false && verdict.retryAfterSeconds).toBe(60);
  });
});

describe("success handling", () => {
  it("clears the username bucket", () => {
    failTimes(4, { username: "alice" });
    recordSuccess("login", { username: "alice" }, T0);
    failTimes(4, { username: "alice" });

    expect(checkRateLimit("login", { username: "alice" }, T0).allowed).toBe(true);
  });

  it("does NOT clear the IP bucket", () => {
    // Otherwise anyone holding one valid account resets their own IP limit.
    for (let i = 0; i < 20; i++) {
      recordFailure("login", { username: `user${i}`, ip: "100.64.0.7" }, T0);
    }
    recordSuccess("login", { username: "alice", ip: "100.64.0.7" }, T0);

    expect(checkRateLimit("login", { ip: "100.64.0.7" }, T0).allowed).toBe(false);
  });
});

describe("memory bounds", () => {
  it("stays bounded when flooded with distinct usernames", () => {
    for (let i = 0; i < 25_000; i++) {
      recordFailure("login", { username: `flood${i}` }, T0);
    }

    // The cap is what stops a trivial memory-exhaustion vector through
    // attacker-chosen keys.
    expect(__rateLimitSize(T0)).toBeLessThanOrEqual(10_000);
  });

  it("preserves an active lockout when the map is flooded", () => {
    // The attack this closes: get locked out, then flood the map with distinct
    // usernames so the eviction drops your own lockout, and resume immediately.
    // Every lockout step is shorter than the window, so expiryOf() ties locked
    // and unlocked entries — leaving insertion order to decide, which evicts
    // the older (real) lockout first.
    failTimes(5, { username: "victim" }, T0);
    expect(checkRateLimit("login", { username: "victim" }, T0).allowed).toBe(false);

    for (let i = 0; i < 25_000; i++) {
      recordFailure("login", { username: `flood${i}` }, T0);
    }

    expect(checkRateLimit("login", { username: "victim" }, T0).allowed).toBe(false);
  });

  it("drops entries once they expire", () => {
    recordFailure("login", { username: "alice" }, T0);
    recordFailure("login", { username: "bob" }, T0 + 20 * MINUTE);

    // alice's entry expired 5 minutes before bob's attempt.
    expect(__rateLimitSize(T0 + 20 * MINUTE)).toBe(1);
  });
});

describe("clientIpFrom", () => {
  it("returns null without the header", () => {
    expect(clientIpFrom(new Request("http://localhost/"))).toBeNull();
  });

  it("takes the rightmost entry, which the trusted proxy appended", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4, 100.64.0.7" },
    });

    // 1.2.3.4 is whatever the client claimed; 100.64.0.7 is what Tailscale saw.
    expect(clientIpFrom(request)).toBe("100.64.0.7");
  });
});
