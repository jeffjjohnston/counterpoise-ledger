import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch, apiGet, apiPost, ApiError, toMessage } from "@/lib/api-client";

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("resolves with the parsed body on a 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: 7 })));
    await expect(apiFetch<{ id: number }>("/api/x")).resolves.toEqual({ id: 7 });
  });

  it("throws ApiError carrying the server's error string and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Account has transactions" }, false, 409))
    );

    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Account has transactions");
    expect((err as ApiError).status).toBe(409);
  });

  it("falls back to a status message when the body is not the { error } envelope", async () => {
    // A 500 that returns an HTML error page: res.json() rejects.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as unknown as Response)
    );

    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Request failed (500)");
  });

  // THE LOAD-BEARING TEST. Nine call sites across seven files guard on
  // err.name === "AbortError". Wrapping it would break every one of them
  // silently: no type error, no lint error, just stale data on screen.
  it("re-throws AbortError as the identical object, unwrapped", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));

    // toBe, not toBeInstanceOf: identity is the strongest possible statement
    // that nothing wrapped, copied, or re-created the rejection.
    await expect(apiFetch("/api/x")).rejects.toBe(abortErr);
  });

  it("re-throws TimeoutError unwrapped (AbortSignal.timeout)", async () => {
    const timeoutErr = Object.assign(new Error("signal timed out"), {
      name: "TimeoutError",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));
    await expect(apiFetch("/api/x")).rejects.toBe(timeoutErr);
  });

  // An abort landing AFTER headers arrive but BEFORE the body finishes
  // streaming surfaces from res.json() rejecting, not from fetch() itself.
  // res.ok is true here, so a naive .catch(() => null) on the json() call
  // would resolve apiFetch with null instead of propagating the abort.
  it("re-throws AbortError from an aborted body read on an ok response, unwrapped", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw abortErr;
        },
      } as unknown as Response)
    );

    await expect(apiFetch("/api/x")).rejects.toBe(abortErr);
  });

  it("re-throws TimeoutError from an aborted body read on an ok response, unwrapped", async () => {
    const timeoutErr = Object.assign(new Error("signal timed out"), {
      name: "TimeoutError",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw timeoutErr;
        },
      } as unknown as Response)
    );

    await expect(apiFetch("/api/x")).rejects.toBe(timeoutErr);
  });

  it("resolves with null (not a rejection) when an ok response's body is genuinely malformed", async () => {
    // Distinguishes the abort case above from a real 2xx-with-bad-JSON
    // response, which must still resolve rather than throw.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as unknown as Response)
    );

    await expect(apiFetch("/api/x")).resolves.toBeNull();
  });

  // A body truncated mid-stream (connection dropped, server died mid-response)
  // makes res.json() reject with a TypeError, not an abort-named error. An
  // allowlist keyed on error name misses this — and Firefox has historically
  // reported an aborted body read itself as a TypeError rather than an
  // AbortError, so this also guards the cross-browser abort case.
  it("re-throws TypeError from a truncated body on an ok response, unwrapped", async () => {
    const truncatedErr = new TypeError("Failed to fetch");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw truncatedErr;
        },
      } as unknown as Response)
    );

    await expect(apiFetch("/api/x")).rejects.toBe(truncatedErr);
  });

  it("passes an AbortSignal through to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await apiGet("/api/x", { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("verb helpers", () => {
  it("apiPost serializes the body and sets the JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { name: "Checking" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/x");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Checking" }));
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("apiGet sends no body and no content-type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/api/x");

    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("lets a caller override headers (plain object) while keeping the content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { a: 1 }, { headers: { "X-Trace": "abc" } });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Trace")).toBe("abc");
  });

  // Regression coverage: ApiInit["headers"] is typed HeadersInit, which also
  // permits a Headers instance or a [string, string][] tuple array. The old
  // implementation merged headers with an object spread, which silently
  // dropped every header from either shape (a Headers instance has no own
  // enumerable properties, so it spread to `{}`).
  it("merges a Headers instance's entries in, alongside the JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { a: 1 }, { headers: new Headers({ "X-Trace": "abc" }) });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.get("X-Trace")).toBe("abc");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("merges a [string, string][] tuple array's entries in, alongside the JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { a: 1 }, { headers: [["X-Trace", "abc"]] });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.get("X-Trace")).toBe("abc");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("keeps a caller-supplied Content-Type instead of overriding it with the default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { a: 1 }, { headers: { "Content-Type": "text/plain" } });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Content-Type")).toBe("text/plain");
  });
});

describe("toMessage", () => {
  it("returns the server's message for an ApiError, not the fallback", () => {
    const err = new ApiError("Account has transactions", 409);
    expect(toMessage(err, "Failed to delete account")).toBe("Account has transactions");
  });

  it("returns the network string for a TypeError, not its own message or the fallback", () => {
    const err = new TypeError("Failed to fetch");
    expect(toMessage(err, "Failed to delete account")).toBe(
      "Network error — check your connection."
    );
  });

  it("returns the fallback for a plain Error, not its own message", () => {
    const err = new Error("boom");
    expect(toMessage(err, "Failed to delete account")).toBe("Failed to delete account");
  });

  it("returns the fallback for a non-Error throw", () => {
    expect(toMessage("boom", "Failed to delete account")).toBe("Failed to delete account");
  });
});
