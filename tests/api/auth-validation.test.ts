import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimits } from "@/lib/rate-limit";
import { setupTestDatabase } from "@/tests/helpers/db-utils";
import { PUT as changePassword } from "@/app/api/auth/password/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { getSession } from "@/lib/session";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

function postJson(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putJson(url: string, body: unknown) {
  return new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await setupTestDatabase();
  __resetRateLimits();
  vi.mocked(getSession).mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.REGISTRATION_ENABLED;
});

describe("POST /api/auth/login validation wiring", () => {
  it("rejects a truthy non-string username with 400 and the ported message, not a 500", async () => {
    // username, not password, is the field that matters here: checkRateLimit()
    // calls .toLowerCase() on it, so a non-string username reaching the
    // limiter throws (the route's own comment on this is the reason
    // loginSchema exists at all). This pins that a dropped/broken superRefine
    // branch would surface as a failing 400 assertion here, not a silent
    // 500 the route's try/catch would mask as a generic "Failed to log in".
    const res = await login(
      postJson("http://localhost/api/auth/login", { username: { evil: true }, password: "hunter2" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Username and password must be strings");
  });
});

describe("POST /api/auth/register validation wiring", () => {
  beforeEach(() => {
    process.env.REGISTRATION_ENABLED = "true";
  });

  it("rejects a username shorter than 3 characters with the ported message", async () => {
    const res = await register(
      postJson("http://localhost/api/auth/register", { username: "ab", password: "password123" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Username must be at least 3 characters");
  });

  it("reports a malformed body as 400, not 403, even when registration is closed (pins the shape-before-gate ordering)", async () => {
    // Registration is closed here on purpose, overriding this describe's own
    // beforeEach: REGISTRATION_ENABLED is unset and setupTestDatabase() seeds
    // one user (id 1), so isRegistrationOpen() reads a non-empty users table
    // and returns false. registerSchema validates the whole body — including
    // guards 3/4, which used to run *after* this gate — before the route
    // ever calls isRegistrationOpen(), so a too-short username still 400s
    // here instead of getting the gate's 403. This is the one documented
    // ordering change in lib/schemas/auth.ts's registerSchema comment; this
    // test pins it so a later edit can't silently move the gate back in
    // front of shape validation without a test failing.
    delete process.env.REGISTRATION_ENABLED;

    const res = await register(
      postJson("http://localhost/api/auth/register", { username: "ab", password: "password123" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Username must be at least 3 characters");
  });
});

describe("PUT /api/auth/password validation wiring", () => {
  it("rejects a new password identical to the current password with 400, not authenticating first", async () => {
    // getSession is mocked to null in beforeEach; if this reached the session
    // check it would 401 instead — this pins that shape validation runs first,
    // matching the original route's guard order.
    const res = await changePassword(
      putJson("http://localhost/api/auth/password", {
        currentPassword: "same-password-123",
        newPassword: "same-password-123",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("New password must be different from current password");
  });

  it("rejects a too-short new password with 400 before the session check", async () => {
    const res = await changePassword(
      putJson("http://localhost/api/auth/password", {
        currentPassword: "old-password-123",
        newPassword: "short",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("New password must be at least 8 characters");
  });
});
