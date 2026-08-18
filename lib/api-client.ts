/**
 * The single client-side entry point for talking to this app's API.
 *
 * Server-side fetches (lib/plaid.ts, lib/tiingo.ts, lib/posthog-query.ts) call
 * EXTERNAL services with their own auth and error shapes. They do not belong
 * here and must not be migrated to it.
 */

/** A non-ok response from our own API, carrying its `{ error }` message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiInit = Omit<RequestInit, "body"> & { body?: unknown };

export async function apiFetch<T>(url: string, init: ApiInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;

  // `headers` is typed HeadersInit, which is a plain Record, a Headers
  // instance, or a [string, string][] tuple array. Only the Record shape
  // survives an object spread — spreading a Headers instance yields `{}`
  // (it has no own enumerable properties) and spreading a tuple array
  // produces index-keyed garbage. Normalizing through the Headers
  // constructor handles all three shapes uniformly. The caller's
  // Content-Type — if they set one, in any of the three shapes — wins.
  let finalHeaders = headers;
  if (body !== undefined) {
    const merged = new Headers(headers);
    if (!merged.has("Content-Type")) merged.set("Content-Type", "application/json");
    finalHeaders = merged;
  }

  // DO NOT wrap this call in a try/catch that rethrows ApiError. A rejection
  // here is a network failure or an abort, and nine call sites across seven
  // files depend on `err.name === "AbortError"` (or "TimeoutError", from
  // AbortSignal.timeout) still matching. Wrapping it lets a cancelled request
  // be mistaken for a real answer, which silently serves stale data.
  const res = await fetch(url, {
    ...rest,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Every route in this app answers with JSON — no route returns 204 or an
  // empty body, and no client code reads .blob()/.text(). res.json() can
  // still reject, and only a genuine parse failure is tolerable here — a
  // 500 serving an HTML error page, or an empty body. Both reject with
  // SyntaxError.
  //
  // Everything else is a transport failure and MUST propagate: an abort or
  // timeout landing mid-body, or a connection dropped mid-stream. Swallowing
  // any of those makes apiFetch resolve with null on an ok response, and the
  // caller's success path then overwrites fresher data with nothing.
  // Allowlisting abort names instead would miss truncated bodies (those
  // reject with TypeError, not an abort-named error), and Firefox reports
  // an aborted body read itself as a TypeError rather than an AbortError.
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }

  if (!res.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return payload as T;
}

export function apiGet<T>(url: string, init?: ApiInit): Promise<T> {
  return apiFetch<T>(url, { ...init, method: "GET" });
}

export function apiPost<T>(url: string, body?: unknown, init?: ApiInit): Promise<T> {
  return apiFetch<T>(url, { ...init, method: "POST", body });
}

export function apiPut<T>(url: string, body?: unknown, init?: ApiInit): Promise<T> {
  return apiFetch<T>(url, { ...init, method: "PUT", body });
}

export function apiDelete<T>(url: string, init?: ApiInit): Promise<T> {
  return apiFetch<T>(url, { ...init, method: "DELETE" });
}

/**
 * Choose what to show a user for a failed request.
 *
 * - ApiError: our own API explained itself — show the server's words.
 * - TypeError: fetch itself rejected, i.e. the request never completed.
 *   The browser's raw text ("Failed to fetch") is not something to show a
 *   user, and it means something specific and actionable.
 * - Anything else: the caller's fallback.
 */
export function toMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Network error — check your connection.";
  return fallback;
}
