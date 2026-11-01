"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, apiGet, toMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { notifyWeeklyReviewSettings } from "@/lib/weekly-review";
import type { WeeklyReviewSettings as Settings } from "@/types";

export function WeeklyReviewSettings({ bookId, bookName }: { bookId: string; bookName: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A read error and a save error are separate: a later read must not
  // hide that a save failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const version = useRef(0);
  // A read during a save can return the old state after the save: skip it.
  const savePending = useRef(false);
  // A read that a save skipped runs when the save ends.
  const reloadAfterSave = useRef(false);
  const loadRef = useRef<() => void>(() => {});
  const url = `/api/b/${bookId}/settings/weekly-review`;

  useEffect(() => {
    let active = true;
    const load = () => {
      if (savePending.current) {
        reloadAfterSave.current = true;
        return;
      }
      const current = ++version.current;
      apiGet<Settings>(url, { cache: "no-store" })
        .then((value) => {
          if (active && current === version.current) {
            setSettings(value);
            setLoadError(null);
          }
        })
        .catch(() => {
          if (active && current === version.current) setLoadError("Could not load the weekly review setting.");
        });
    };
    loadRef.current = load;
    load();
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener("focus", load);
    };
  }, [url]);

  async function save(enabled: boolean, clear = false) {
    savePending.current = true;
    version.current++;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await apiFetch<Settings>(url, clear ? { method: "DELETE" } : { method: "PATCH", body: { enabled } });
      // A read that started before the save ended is older than this answer.
      version.current++;
      setSettings(saved);
      // The answer is the current state, so an earlier read error is old.
      setLoadError(null);
      setConfirming(false);
      notifyWeeklyReviewSettings(bookId);
    } catch (err) {
      setSaveError(toMessage(err, "Could not save the setting. Your previous setting is still in effect."));
    } finally {
      savePending.current = false;
      setSaving(false);
      if (reloadAfterSave.current) {
        reloadAfterSave.current = false;
        loadRef.current();
      }
    }
  }

  return (
    <section className="pt-4 border-t border-border space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">Weekly review</h3>
        <p className="mt-1 text-xs text-fg-tertiary">Applies to {bookName}.</p>
      </div>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={!settings || saving || (!settings.configured && !settings.enabled)}
          onChange={(e) => void save(e.target.checked)}
          className="mt-1"
        />
        Weekly review on the dashboard
      </label>
      <p className="text-xs text-fg-secondary">
        Each Monday, the transactions of the past week, including memos and account names, the monthly totals of
        the 13 months before, and the recurring rules go to Anthropic. Claude returns a short summary and items to
        check. Nothing in the book changes.
      </p>
      {settings && !settings.configured && (
        <p className="text-xs text-fg-tertiary">The weekly review is not available on this installation.</p>
      )}
      {saving && <p role="status" className="text-xs text-fg-secondary">Saving…</p>}
      {(saveError ?? loadError) && (
        <p role="alert" className="text-xs text-fg-danger">
          {saveError ?? loadError}
        </p>
      )}
      {confirming ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-secondary">
            Turn off the weekly review and delete the reviews of this book? This does not recall data already sent.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => void save(false, true)}>
              Delete reviews
            </Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" disabled={!settings || saving} onClick={() => setConfirming(true)}>
          Turn off and delete reviews
        </Button>
      )}
    </section>
  );
}
