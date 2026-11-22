"use client";

import { useEffect, useState } from "react";
import { useBookChanges } from "@/components/BookChangesProvider";
import { apiGet } from "@/lib/api-client";
import {
  BOOK_FEATURES,
  FEATURE_DOTS_EVENT,
  isDotCleared,
  isFeatureNew,
  isFeatureStorageEvent,
  localToday,
  recordFirstSeen,
  shouldShowDot,
  type BookFeatureState,
} from "@/lib/features";
import { subscribeTypeSafeSettings } from "@/lib/typesafe/events";
import { WEEKLY_REVIEW_SETTINGS_EVENT } from "@/lib/weekly-review";

/** The key is `<bookId>:<feature id>`, so a state of one book is not used for another. */
type States = Partial<Record<string, BookFeatureState>>;

/**
 * True when a feature of the book is new and the user can turn it on. The
 * navbar shows a dot then. A viewer sends no request. A feature that is not
 * new, or whose dot is cleared, sends no request: its state cannot show a
 * dot. A failed read counts as no dot.
 */
export function useNewFeatureDot(bookId: string, canWrite: boolean): boolean {
  const [states, setStates] = useState<States>({});
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  const today = localToday();
  const candidates = canWrite
    ? BOOK_FEATURES.filter((feature) => isFeatureNew(feature.id, today) && !isDotCleared(bookId, feature.id))
    : [];
  const candidateIds = candidates.map((feature) => feature.id).join(",");

  useEffect(() => {
    // The 60 days of "new" start when a user who can turn the feature on first sees the book.
    if (canWrite) recordFirstSeen(BOOK_FEATURES.map((feature) => feature.id), localToday());
  }, [canWrite]);

  useEffect(() => {
    if (!candidateIds) return;
    const ids = candidateIds.split(",");
    let active = true;
    for (const feature of BOOK_FEATURES) {
      if (!ids.includes(feature.id)) continue;
      const key = `${bookId}:${feature.id}`;
      apiGet<BookFeatureState>(feature.settingsUrl(bookId), { cache: "no-store" })
        .then((value) => {
          if (active) setStates((current) => ({ ...current, [key]: value }));
        })
        .catch(() => {
          if (active) setStates((current) => ({ ...current, [key]: undefined }));
        });
    }
    return () => { active = false; };
  }, [bookId, candidateIds, version]);

  useBookChanges((change) => {
    if (change.type === "reset" || change.tables.includes("books")) reload();
  });

  useEffect(() => {
    const onWeeklyReview = (event: Event) => {
      if ((event as CustomEvent<{ bookId: string }>).detail?.bookId === bookId) reload();
    };
    // The dots that clearDots records live in storage, so read them again.
    const onDots = () => setStates((current) => ({ ...current }));
    // Another tab of this browser cleared a dot or recorded a first sight.
    const onStorage = (event: StorageEvent) => {
      if (isFeatureStorageEvent(event)) onDots();
    };
    const unsubscribe = subscribeTypeSafeSettings(bookId, reload);
    window.addEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, onWeeklyReview);
    window.addEventListener(FEATURE_DOTS_EVENT, onDots);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, onWeeklyReview);
      window.removeEventListener(FEATURE_DOTS_EVENT, onDots);
      window.removeEventListener("storage", onStorage);
    };
  }, [bookId]);

  return candidates.some((feature) => {
    const state = states[`${bookId}:${feature.id}`];
    return state !== undefined && shouldShowDot({ isNew: true, cleared: false, state, canWrite });
  });
}
