import { afterEach, describe, it, expect } from "vitest";
import { verifyCronSecret } from "@/lib/cron-auth";

function request(authorization?: string) {
  return new Request("http://localhost/api/cron/recurring", {
    headers: authorization ? { authorization } : {},
  });
}

describe("verifyCronSecret", () => {
  // Named originalCronSecret to match the other cron test files. The secret
  // scanner's CRON_SECRET rule matches `CRON_SECRET = <unquoted value>`, which
  // an env-restore assignment looks exactly like, so .gitleaks.toml allowlists
  // this identifier by name. A different name here fails the scan.
  const originalCronSecret = process.env.CRON_SECRET;
  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("accepts the correct bearer token", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronSecret(request("Bearer s3cret"))).toBe(true);
  });

  it("rejects a wrong token", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronSecret(request("Bearer wrong"))).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual throws on length mismatch, which is why the comparison
    // is over fixed-width digests rather than the raw strings.
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronSecret(request("Bearer much-much-longer-value"))).toBe(false);
  });

  it("rejects a missing header", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronSecret(request())).toBe(false);
  });

  it("fails closed when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronSecret(request("Bearer anything"))).toBe(false);
    // Without the !cronSecret guard the expected value interpolates to the
    // literal "Bearer undefined", which would then authenticate. This is the
    // assertion that fails if the guard is ever removed.
    expect(verifyCronSecret(request("Bearer undefined"))).toBe(false);
  });
});
