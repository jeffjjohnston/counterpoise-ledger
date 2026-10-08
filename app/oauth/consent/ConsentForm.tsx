"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiGet, apiPost, toMessage } from "@/lib/api-client";

/** What `GET /api/oauth/consent` gives for a request that passed the checks. */
export type ConsentDetails = {
  client: {
    name: string;
    clientId: string;
    /** True when a Client ID Metadata Document gives the client: its host is known. */
    metadataDocument: boolean;
    host: string | null;
  };
  redirectUri: string;
  redirectHost: string;
  /** Every redirect URI of the client is on this computer (localhost). */
  loopbackOnly: boolean;
  username: string | null;
  server: string;
};

/** A decision: the page goes to the app's redirect URI. */
type Redirect = { redirectTo: string };

/**
 * A request that the server refused after it found the client and the
 * redirect URI. OAuth sends the error to the app at that URI, but the page
 * does not go there on its own. Every client registers itself, so the URI
 * proves nothing about the destination: an automatic redirect would make
 * this origin an open redirector (RFC 9700 section 4.11.2). The page shows
 * the error and the host, and goes there when the user clicks.
 */
type Refused = { error: string; returnTo: string; returnHost: string };

/** Opens a URL of another site. */
function leavePage(url: string): void {
  window.location.assign(url);
}

/**
 * The OAuth consent page. `/api/oauth/authorize` sends the browser here with
 * the authorization request as the query. The server checks the request; the
 * page shows which app asks, and where the browser goes after the decision.
 *
 * The page sends the browser to the app in JavaScript, not with a form: the
 * Content-Security-Policy has `form-action 'self'`, which also applies to the
 * redirect after a form post.
 */
export function ConsentForm({
  query,
  leave = leavePage,
}: {
  query: string;
  /** Opens the app's redirect URI. A test gives its own. */
  leave?: (url: string) => void;
}) {
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await apiGet<ConsentDetails | Refused>(`/api/oauth/consent?${query}`);
        if ("returnTo" in data) {
          setRefused(data);
          return;
        }
        setDetails(data);
      } catch (err) {
        setError(toMessage(err, "Could not read the request from the app"));
      }
    };
    // load handles its own errors.
    void load();
  }, [query, leave]);

  const decide = async (approve: boolean) => {
    setError("");
    setDeciding(true);
    try {
      const data = await apiPost<Redirect | Refused>("/api/oauth/consent", { query, approve });
      if ("returnTo" in data) {
        setRefused(data);
        setDeciding(false);
        return;
      }
      setLeaving(true);
      leave(data.redirectTo);
    } catch (err) {
      setError(toMessage(err, "Could not send your decision"));
      setDeciding(false);
    }
  };

  const returnToApp = () => {
    if (!refused) return;
    setLeaving(true);
    leave(refused.returnTo);
  };

  const message = error || refused?.error || "";

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="w-full max-w-md px-4">
        <div className="bg-surface rounded-xl shadow-soft border border-border p-8">
          <div className="text-center mb-6">
            <div
              className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-soft"
              role="img"
              aria-label="Counterpoise"
            >
              <span className="text-2xl font-bold text-fg-on-accent" aria-hidden="true">
                C
              </span>
            </div>
            <h1 className="text-xl font-bold text-fg">
              {details ? `Connect ${details.client.name} to Counterpoise?` : "Connect an app"}
            </h1>
            {details?.username && (
              <p className="text-fg-tertiary mt-1 text-sm">Signed in as {details.username}</p>
            )}
          </div>

          {message && (
            <div role="alert" className="bg-danger-subtle text-fg-danger px-4 py-3 rounded-lg text-sm mb-4">
              {message}
            </div>
          )}

          {leaving && <p className="text-sm text-fg-tertiary text-center">Returning to the app...</p>}

          {!details && !message && !leaving && (
            <p className="text-sm text-fg-tertiary text-center">Loading...</p>
          )}

          {refused && !leaving && (
            <div className="space-y-4">
              <p className="text-sm text-fg">
                The app can get this answer at <strong className="break-all">{refused.returnHost}</strong>.
                Go there only if you started this connection yourself.
              </p>
              <Button type="button" variant="secondary" className="w-full" onClick={returnToApp}>
                Return to {refused.returnHost}
              </Button>
            </div>
          )}

          {details && !refused && !leaving && (
            <div className="space-y-4" data-testid="consent-ready">
              <p className="text-sm text-fg">
                <strong>{details.client.name}</strong> will be able to read and change the data in
                every book that you can open, with the Counterpoise MCP tools. Your role in each
                book still applies.
              </p>

              <dl className="text-sm border border-border rounded-lg divide-y divide-border">
                <div className="flex justify-between gap-4 px-4 py-2">
                  <dt className="text-fg-tertiary">App</dt>
                  <dd className="text-fg text-right break-words">
                    {details.client.metadataDocument && details.client.host
                      ? `Published by ${details.client.host}`
                      : "Registered itself (Counterpoise cannot verify its name)"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 px-4 py-2">
                  <dt className="text-fg-tertiary">Returns to</dt>
                  <dd className="text-fg text-right font-medium break-all">{details.redirectHost}</dd>
                </div>
              </dl>

              {details.loopbackOnly && (
                <div className="bg-warning-subtle border border-border px-4 py-3 rounded-lg text-sm text-fg">
                  This app returns to a program on your computer ({details.redirectHost}). Any
                  program on this computer can claim to be that app. Approve only if you started
                  this connection yourself just now.
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  disabled={deciding}
                  onClick={() => void decide(false)}
                >
                  Deny
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={deciding}
                  onClick={() => void decide(true)}
                >
                  Approve
                </Button>
              </div>
              <p className="text-xs text-fg-tertiary">
                You can disconnect the app at any time on your account page.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
