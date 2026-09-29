import { randomBytes, scrypt, timingSafeEqual } from "crypto";

const KEY_PREFIX = "cpk_";
const KEY_BYTES = 24; // 48 hex chars

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString("hex");
}

export function getKeyPrefix(key: string): string {
  return key.slice(0, 8);
}

export async function hashApiKey(key: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(key, salt, 32, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyApiKey(
  key: string,
  hash: string
): Promise<boolean> {
  const [salt, storedKey] = hash.split(":");
  if (!salt || !storedKey) return false;
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(key, salt, 32, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  const storedBuffer = Buffer.from(storedKey, "hex");
  if (derivedKey.length !== storedBuffer.length) return false;
  return timingSafeEqual(derivedKey, storedBuffer);
}
