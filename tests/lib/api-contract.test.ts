import { afterEach, describe, expect, it } from "vitest";
import { API_CONTRACT, getAppVersion } from "@/lib/api-contract";

describe("api contract", () => {
  const original = process.env.NEXT_PUBLIC_APP_VERSION;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
    else process.env.NEXT_PUBLIC_APP_VERSION = original;
  });

  it("is a positive integer", () => {
    expect(Number.isInteger(API_CONTRACT)).toBe(true);
    expect(API_CONTRACT).toBeGreaterThan(0);
  });

  it("reads the build-time version", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
    expect(getAppVersion()).toBe("9.9.9");
  });

  it("falls back to a dev marker when unset", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    expect(getAppVersion()).toBe("0.0.0-dev");
  });
});
