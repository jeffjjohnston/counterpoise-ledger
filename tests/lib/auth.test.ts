import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, generateSessionToken } from "@/lib/auth";

describe("hashPassword", () => {
  it("returns a string in salt:hash format", async () => {
    const hash = await hashPassword("test-password");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);
  });

  it("salt portion is 64 hex characters (32 bytes)", async () => {
    const hash = await hashPassword("test-password");
    const [salt] = hash.split(":");
    expect(salt).toHaveLength(64);
    expect(salt).toMatch(/^[0-9a-f]+$/);
  });

  it("key portion is 128 hex characters (64 bytes)", async () => {
    const hash = await hashPassword("test-password");
    const [, key] = hash.split(":");
    expect(key).toHaveLength(128);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("produces a different hash each time due to random salt", async () => {
    const hash1 = await hashPassword("test-password");
    const hash2 = await hashPassword("test-password");
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different passwords", async () => {
    const hash1 = await hashPassword("password-one");
    const hash2 = await hashPassword("password-two");
    expect(hash1).not.toBe(hash2);
  });

  it("handles an empty password", async () => {
    const hash = await hashPassword("");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(64);
    expect(parts[1]).toHaveLength(128);
  });

  it("handles a password with special characters", async () => {
    const hash = await hashPassword("p@$$w0rd!#&*()");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const hash = await hashPassword("my-secret-password");
    expect(await verifyPassword("my-secret-password", hash)).toBe(true);
  });

  it("returns false for an incorrect password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("returns false for an empty password against a non-empty hash", async () => {
    const hash = await hashPassword("some-password");
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("returns false when hash is malformed (no colon separator)", async () => {
    expect(await verifyPassword("password", "notavalidhash")).toBe(false);
  });

  it("returns false when hash is an empty string", async () => {
    expect(await verifyPassword("password", "")).toBe(false);
  });

  it("returns false when salt portion is empty", async () => {
    expect(await verifyPassword("password", ":somekeyhex")).toBe(false);
  });

  it("returns false when key portion is empty", async () => {
    expect(await verifyPassword("password", "somesalthex:")).toBe(false);
  });

  it("correctly distinguishes multiple passwords from multiple hashes", async () => {
    const passwords = ["alpha", "beta", "gamma"];
    const hashes = await Promise.all(passwords.map(hashPassword));
    for (let i = 0; i < passwords.length; i++) {
      for (let j = 0; j < passwords.length; j++) {
        const expected = i === j;
        const actual = await verifyPassword(passwords[i], hashes[j]);
        expect(actual).toBe(expected);
      }
    }
  });

  it("handles verification of an empty password that was hashed empty", async () => {
    const hash = await hashPassword("");
    expect(await verifyPassword("", hash)).toBe(true);
    expect(await verifyPassword("not-empty", hash)).toBe(false);
  });
});

describe("generateSessionToken", () => {
  it("returns a 64-character string", () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(64);
  });

  it("returns only lowercase hex characters", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("produces a unique token on each call", () => {
    const tokens = new Set(Array.from({ length: 20 }, generateSessionToken));
    expect(tokens.size).toBe(20);
  });
});
