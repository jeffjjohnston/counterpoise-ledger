import { afterEach, describe, it, expect } from "vitest";
import nextConfig from "@/next.config.js";

async function headerMap() {
  const rules = await nextConfig.headers!();
  return new Map(rules[0].headers.map((h) => [h.key, h.value]));
}

describe("security headers", () => {
  const original = process.env.ENABLE_HSTS;
  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_HSTS;
    else process.env.ENABLE_HSTS = original;
  });

  it("sets framing, sniffing and referrer policy", async () => {
    const headers = await headerMap();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("does not advertise the framework via X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("ships a CSP that does not restrict scripts or styles", async () => {
    const csp = (await headerMap()).get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    // Adding either would risk breaking Next.js hydration and PostHog; that
    // was deferred deliberately, so assert it stays deferred.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
  });

  it("omits HSTS unless explicitly enabled", async () => {
    delete process.env.ENABLE_HSTS;
    expect((await headerMap()).has("Strict-Transport-Security")).toBe(false);
  });

  it("sends HSTS when enabled", async () => {
    process.env.ENABLE_HSTS = "true";
    expect((await headerMap()).get("Strict-Transport-Security"))
      .toBe("max-age=31536000; includeSubDomains");
  });
});
