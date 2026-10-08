"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiDelete, apiGet, toMessage } from "@/lib/api-client";

/** One row of `GET /api/oauth/grants`. */
type ConnectedApp = {
  id: number;
  clientName: string;
  /** The host that publishes the app's metadata document, when it has one. */
  clientHost: string | null;
  redirectHost: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

/**
 * The apps that the user connected with OAuth, such as a claude.ai custom
 * connector. To revoke one deletes its tokens, so its next MCP call fails.
 */
export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        setApps(await apiGet<ConnectedApp[]>("/api/oauth/grants"));
      } catch (err) {
        setError(toMessage(err, "Failed to load connected apps"));
      } finally {
        setIsLoading(false);
      }
    };
    // load catches its own errors into `error`; it cannot reject.
    void load();
  }, []);

  const handleRevoke = async (id: number) => {
    setError("");
    try {
      await apiDelete(`/api/oauth/grants/${id}`);
      setApps((current) => current.filter((app) => app.id !== id));
    } catch (err) {
      setError(toMessage(err, "Failed to disconnect the app"));
    }
  };

  if (isLoading) return <p className="text-sm text-fg-tertiary">Loading connected apps...</p>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-danger-subtle border border-border text-fg-danger px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {apps.length > 0 ? (
        <div className="divide-y divide-border border border-border rounded-lg">
          {apps.map((app) => (
            <div key={app.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{app.clientName}</p>
                <p className="text-xs text-fg-tertiary break-words">
                  {app.clientHost ? `Published by ${app.clientHost}` : `Returns to ${app.redirectHost ?? "an unknown host"}`}
                  {" · "}
                  Connected {new Date(app.createdAt).toLocaleDateString()}
                  {app.lastUsedAt && (
                    <>
                      {" · "}
                      Last used {new Date(app.lastUsedAt).toLocaleDateString()}
                    </>
                  )}
                </p>
              </div>
              <Button type="button" variant="danger" size="sm" onClick={() => void handleRevoke(app.id)}>
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-fg-tertiary">No connected apps.</p>
      )}
    </div>
  );
}
