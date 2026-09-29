"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, apiGet, toMessage } from "@/lib/api-client";
import {
  notifyTypeSafeSettings,
  subscribeTypeSafeSettings,
} from "@/lib/typesafe/events";
import type { TypeSafeSettings as Settings } from "@/lib/typesafe/types";
import { Button } from "@/components/ui/Button";

export function TypeSafeSettings({
  bookId,
  bookName,
}: {
  bookId: string;
  bookName: string;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const requestVersion = useRef(0);
  const savePending = useRef(false);
  const url = `/api/b/${bookId}/settings/typesafe`;
  useEffect(() => {
    let active = true;
    const load = () => {
      if (savePending.current) return;
      const version = ++requestVersion.current;
      apiGet<Settings>(url, { cache: "no-store" })
        .then((value) => {
          if (active && version === requestVersion.current) {
            setSettings(value);
            setError(null);
          }
        })
        .catch(() => {
          if (active && version === requestVersion.current)
            setError("Could not load TypeSafe settings.");
        });
    };
    load();
    const unsubscribe = subscribeTypeSafeSettings(bookId, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", load);
    };
  }, [bookId, url]);
  async function save(enabled: boolean, clear = false) {
    savePending.current = true;
    requestVersion.current++;
    setSaving(true);
    setError(null);
    try {
      const value = await apiFetch<Settings>(
        url,
        clear ? { method: "DELETE" } : { method: "PATCH", body: { enabled } },
      );
      setSettings(value);
      setClearing(false);
      notifyTypeSafeSettings(bookId);
    } catch (err) {
      setError(
        toMessage(
          err,
          "Could not save TypeSafe settings. Your previous setting is still in effect.",
        ),
      );
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="pt-4 border-t border-border space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">
          TypeSafe AI — Experimental
        </h3>
        <p className="mt-1 text-xs text-fg-tertiary">Applies to {bookName}.</p>
      </div>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={
            !settings || saving || (!settings.configured && !settings.enabled)
          }
          onChange={(e) => void save(e.target.checked)}
          className="mt-1"
        />
        Suggest Plaid transaction matches
      </label>
      <p className="text-xs text-fg-secondary">
        Sends merchant descriptions, amounts, dates, and candidate payee names
        to TypeSafe to suggest an existing transaction. You confirm every match.
        Turn this off to stop new requests and hide suggestions.
      </p>
      {settings && !settings.configured && (
        <p className="text-xs text-fg-tertiary">
          TypeSafe is unavailable on this installation.
        </p>
      )}
      {saving && (
        <p role="status" className="text-xs text-fg-secondary">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-fg-danger">
          {error}
        </p>
      )}
      <p className="text-xs text-fg-tertiary">
        Detailed experiment records are kept locally for 30 days. Turning this
        off does not erase earlier records or recall data already sent.
      </p>
      {clearing ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-secondary">
            Disable suggestions and delete this book’s local experiment records?
            This does not delete data held by TypeSafe.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => void save(false, true)}
            >
              Disable and clear
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => setClearing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={!settings || saving}
          onClick={() => setClearing(true)}
        >
          Clear experiment data
        </Button>
      )}
    </section>
  );
}
