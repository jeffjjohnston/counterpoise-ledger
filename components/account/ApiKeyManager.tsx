"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { apiGet, apiPost, apiDelete, toMessage } from "@/lib/api-client";

type ApiKey = {
  id: number;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export function ApiKeyManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchKeys = async () => {
    try {
      const data = await apiGet<ApiKey[]>("/api/auth/api-keys");
      setKeys(data);
    } catch (err) {
      setError(toMessage(err, "Failed to load API keys"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // fetchKeys already catches its own errors into `error` in a
    // try/finally; it cannot reject.
    void fetchKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNewKeyValue(null);
    if (!newKeyName.trim()) {
      setError("Key name is required");
      return;
    }

    setIsCreating(true);
    try {
      const data = await apiPost<{ key: string }>("/api/auth/api-keys", {
        name: newKeyName.trim(),
      });
      setNewKeyValue(data.key);
      setNewKeyName("");
      // fetchKeys already catches its own errors into `error` in a
      // try/finally; it cannot reject.
      void fetchKeys();
    } catch (err) {
      setError(toMessage(err, "Failed to create API key"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/api/auth/api-keys/${id}`);
      setKeys(keys.filter((k) => k.id !== id));
    } catch (err) {
      setError(toMessage(err, "Failed to delete API key"));
    }
  };

  const handleCopy = async () => {
    if (newKeyValue) {
      await navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isLoading) return <p className="text-sm text-fg-tertiary">Loading API keys...</p>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-danger-subtle border border-border text-fg-danger px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {newKeyValue && (
        <div className="bg-warning-subtle border border-border px-4 py-3 rounded-lg text-sm space-y-2">
          <p className="font-medium text-fg">
            Copy your API key now. It will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-surface-inset px-3 py-2 rounded text-xs font-mono break-all">
              {newKeyValue}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCopy}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={handleCreate} className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            id="api-key-name"
            label="New API key"
            placeholder="e.g., Claude Desktop"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={isCreating} size="sm">
          {isCreating ? "Creating..." : "Create key"}
        </Button>
      </form>

      {keys.length > 0 && (
        <div className="divide-y divide-border border border-border rounded-lg">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-fg">{key.name}</p>
                <p className="text-xs text-fg-tertiary">
                  <code>{key.keyPrefix}...</code>
                  {" \u00B7 "}
                  Created {new Date(key.createdAt).toLocaleDateString()}
                  {key.lastUsedAt && (
                    <>
                      {" \u00B7 "}
                      Last used{" "}
                      {new Date(key.lastUsedAt).toLocaleDateString()}
                    </>
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => handleDelete(key.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}

      {keys.length === 0 && !newKeyValue && (
        <p className="text-sm text-fg-tertiary">
          No API keys yet. Create one to use with the MCP server.
        </p>
      )}
    </div>
  );
}
