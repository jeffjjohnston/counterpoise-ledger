import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessExpired, renewAccessSession } from "@/lib/access-session";
import { apiFetch, ApiError } from "@/lib/api-client";

const redirected = { type: "opaqueredirect", status: 0, ok: false } as Response;

describe("Cloudflare Access expiry", () => {
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tells an Access redirect from an answer of the app", () => {
    expect(accessExpired(redirected)).toBe(true);
    expect(accessExpired(new Response(null, { status: 401 }))).toBe(false);
  });

  it("reloads once a minute at most", () => {
    expect(renewAccessSession()).toBe(true);
    expect(renewAccessSession()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(renewAccessSession()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("makes apiFetch reload the page and reject, without following the redirect", async () => {
    const fetch = vi.fn().mockResolvedValue(redirected);
    vi.stubGlobal("fetch", fetch);
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
