import { expect } from "vitest";

/**
 * The row holds the ciphertext of `token` under a key ID, not the token: the
 * base64 of a 24-byte nonce, the ciphertext and a 16-byte tag
 * (`rust-api/server/src/plaid_token_keys.rs`).
 */
export function expectSealed(stored: { accessToken: string; accessTokenKey: string | null }, token: string) {
  expect(stored.accessTokenKey).toMatch(/^[0-9a-f]{8}$/);
  expect(stored.accessToken).not.toContain(token);
  expect(Buffer.from(stored.accessToken, "base64").length).toBe(24 + Buffer.byteLength(token) + 16);
}
