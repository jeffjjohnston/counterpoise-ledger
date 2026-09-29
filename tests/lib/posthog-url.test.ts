import { describe, it, expect } from "vitest";

import { redactedCaptureUrl } from "@/lib/posthog-url";

const ORIGIN = "https://counterpoise.example";

describe("redactedCaptureUrl", () => {
  it("does not send the search text of a ?q= query", () => {
    const url = redactedCaptureUrl(ORIGIN, "/b/1/search", "?q=Whole+Foods");

    expect(url).not.toContain("Whole");
    expect(url).not.toContain("Foods");
    expect(url).toBe(`${ORIGIN}/b/1/search?q=[redacted]`);
  });

  it("redacts every value and keeps the parameter names in order", () => {
    const url = redactedCaptureUrl(
      ORIGIN,
      "/b/1/search",
      "?q=rent&startDate=2026-01-01&endDate=2026-03-31",
    );

    expect(url).toBe(
      `${ORIGIN}/b/1/search?q=[redacted]&startDate=[redacted]&endDate=[redacted]`,
    );
  });

  it("returns the bare path with no trailing ? when there is no query string", () => {
    expect(redactedCaptureUrl(ORIGIN, "/b/1/accounts", "")).toBe(
      `${ORIGIN}/b/1/accounts`,
    );
  });

  it("still names a parameter that was given an empty value", () => {
    expect(redactedCaptureUrl(ORIGIN, "/b/1/search", "?q=")).toBe(
      `${ORIGIN}/b/1/search?q=[redacted]`,
    );
  });

  it("redacts a parameter it has never heard of", () => {
    const url = redactedCaptureUrl(ORIGIN, "/b/1/register", "?memo=birthday+gift");

    expect(url).toBe(`${ORIGIN}/b/1/register?memo=[redacted]`);
  });

  it("cannot be made to leak by a value carrying & or =", () => {
    const url = redactedCaptureUrl(
      ORIGIN,
      "/b/1/search",
      "?q=" + encodeURIComponent("a&payee=Whole Foods"),
    );

    expect(url).not.toContain("Whole");
    expect(url).toBe(`${ORIGIN}/b/1/search?q=[redacted]`);
  });

  it("redacts every occurrence of a repeated parameter", () => {
    const url = redactedCaptureUrl(ORIGIN, "/b/1/register", "?accountIds=4&accountIds=9");

    expect(url).toBe(
      `${ORIGIN}/b/1/register?accountIds=[redacted]&accountIds=[redacted]`,
    );
  });

  it("accepts a query string that omits the leading ?", () => {
    expect(redactedCaptureUrl(ORIGIN, "/b/1/search", "q=rent")).toBe(
      `${ORIGIN}/b/1/search?q=[redacted]`,
    );
  });
});

describe("redactedCaptureUrl parameter names", () => {
  it("re-encodes a parameter name so it cannot split into two parameters", () => {
    const url = redactedCaptureUrl(
      ORIGIN,
      "/b/1/search",
      "?" + encodeURIComponent("a&b=c") + "=rent",
    );

    expect(url).toBe(`${ORIGIN}/b/1/search?a%26b%3Dc=[redacted]`);
  });
});
