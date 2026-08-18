import { describe, it, expect } from "vitest";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  createApiKeySchema,
} from "@/lib/schemas/auth";

describe("loginSchema", () => {
  it("accepts valid credentials", () => {
    const r = loginSchema.safeParse({ username: "alice", password: "hunter2" });
    expect(r.success).toBe(true);
  });

  it("rejects a missing password with the ported message", () => {
    const r = loginSchema.safeParse({ username: "alice" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });

  it("rejects a missing username with the ported message", () => {
    const r = loginSchema.safeParse({ password: "hunter2" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });

  it("rejects an empty-string username with the required message, not the type message", () => {
    const r = loginSchema.safeParse({ username: "", password: "hunter2" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });

  it("rejects a falsy numeric username (0) with the required message", () => {
    const r = loginSchema.safeParse({ username: 0, password: "hunter2" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });

  it("rejects a truthy non-string username with the string-type message", () => {
    const r = loginSchema.safeParse({ username: { evil: true }, password: "hunter2" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password must be strings");
  });

  it("rejects a truthy non-string password with the string-type message", () => {
    const r = loginSchema.safeParse({ username: "alice", password: ["a"] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password must be strings");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message, not zod's generic type text", (_label, input) => {
    // The original route destructures `{ username, password }` straight off
    // the parsed body. An array/string/number/boolean auto-boxes without
    // throwing (username/password come out undefined, same as a body
    // simply missing the keys) — only a literal `null` body threw. All five
    // had — or, for null, now gain — the same "required" message at 400.
    const r = loginSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });
});

describe("registerSchema", () => {
  it("accepts a valid username and password", () => {
    const r = registerSchema.safeParse({ username: "alice", password: "password123" });
    expect(r.success).toBe(true);
  });

  it("rejects missing fields with the required message", () => {
    const r = registerSchema.safeParse({ username: "alice" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });

  it("rejects a username shorter than 3 characters", () => {
    const r = registerSchema.safeParse({ username: "ab", password: "password123" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username must be at least 3 characters");
  });

  it("rejects a non-string username with the length message (not the required message)", () => {
    const r = registerSchema.safeParse({ username: { evil: true }, password: "password123" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username must be at least 3 characters");
  });

  it("rejects a password shorter than 8 characters", () => {
    const r = registerSchema.safeParse({ username: "alice", password: "short" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Password must be at least 8 characters");
  });

  it("reports the username-length message before the password-length message when both are invalid", () => {
    const r = registerSchema.safeParse({ username: "ab", password: "short" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username must be at least 3 characters");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = registerSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Username and password are required");
  });
});

describe("changePasswordSchema", () => {
  it("accepts a valid password change", () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: "old-password-123",
      newPassword: "new-password-123",
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing fields with the required message", () => {
    const r = changePasswordSchema.safeParse({ currentPassword: "old-password-123" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Current password and new password are required"
    );
  });

  it("rejects a non-string field with the payload message", () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: "old-password-123",
      newPassword: 12345,
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Invalid password payload");
  });

  it("rejects a new password shorter than 8 characters", () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: "old-password-123",
      newPassword: "short",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("New password must be at least 8 characters");
  });

  it("rejects a new password identical to the current password", () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: "same-password-123",
      newPassword: "same-password-123",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "New password must be different from current password"
    );
  });

  it("does not report 'must be different' when a shorter check already failed", () => {
    // newPassword is both < 8 chars AND equal to currentPassword; the length
    // check must win, matching the original route's guard order.
    const r = changePasswordSchema.safeParse({
      currentPassword: "short",
      newPassword: "short",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("New password must be at least 8 characters");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = changePasswordSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe(
      "Current password and new password are required"
    );
  });
});

describe("createApiKeySchema", () => {
  it("accepts a valid name", () => {
    const r = createApiKeySchema.safeParse({ name: "My MCP Key" });
    expect(r.success).toBe(true);
  });

  it("trims the stored name", () => {
    const r = createApiKeySchema.safeParse({ name: "  My MCP Key  " });
    expect(r.success).toBe(true);
    expect(r.data!.name).toBe("My MCP Key");
  });

  it("rejects an empty name with the ported message", () => {
    const r = createApiKeySchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects a whitespace-only name with the ported message", () => {
    const r = createApiKeySchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it("rejects a missing name with the ported message", () => {
    const r = createApiKeySchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "abc"],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a non-object body (%s) with the ported required message", (_label, input) => {
    const r = createApiKeySchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("Name is required");
  });
});
