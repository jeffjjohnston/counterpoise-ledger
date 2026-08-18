import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey, verifyApiKey, getKeyPrefix } from "@/lib/api-keys";

describe("api-keys", () => {
  describe("generateApiKey", () => {
    it("returns a string starting with 'cpk_'", () => {
      const key = generateApiKey();
      expect(key).toMatch(/^cpk_[a-f0-9]{48}$/);
    });

    it("generates unique keys", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe("getKeyPrefix", () => {
    it("returns first 8 characters of the key", () => {
      const key = "cpk_abcdef1234567890abcdef1234567890abcdef12345678";
      expect(getKeyPrefix(key)).toBe("cpk_abcd");
    });
  });

  describe("hashApiKey / verifyApiKey", () => {
    it("hashes a key and verifies it", async () => {
      const key = generateApiKey();
      const hash = await hashApiKey(key);
      expect(hash).not.toBe(key);
      expect(await verifyApiKey(key, hash)).toBe(true);
    });

    it("rejects incorrect key", async () => {
      const key = generateApiKey();
      const hash = await hashApiKey(key);
      const wrongKey = generateApiKey();
      expect(await verifyApiKey(wrongKey, hash)).toBe(false);
    });
  });
});
