"use client";

import { useEffect, useState, type ReactNode } from "react";
import { TypeSafeSettings } from "@/components/settings/TypeSafeSettings";
import { WeeklyReviewSettings } from "@/components/settings/WeeklyReviewSettings";
import { BOOK_FEATURES, clearDots, isFeatureNew, localToday, recordFirstSeen, type BookFeature } from "@/lib/features";

function featureBody(feature: BookFeature, bookId: string, bookName: string): ReactNode {
  switch (feature.id) {
    case "typesafe":
      return <TypeSafeSettings bookId={bookId} bookName={bookName} />;
    case "weekly-review":
      return <WeeklyReviewSettings bookId={bookId} bookName={bookName} />;
  }
}

/**
 * The optional features of the book, at the top of the book group. `seen` is
 * true while the Features section is the section that the user reads.
 */
export function BookFeaturesSettings({ bookId, bookName, canWrite, seen }: {
  bookId: string;
  bookName: string;
  canWrite: boolean;
  seen: boolean;
}) {
  // Read once per mount: the effect below can record today as the first sight.
  const [newIds] = useState(() => new Set(BOOK_FEATURES.filter((f) => isFeatureNew(f.id, localToday())).map((f) => f.id)));

  useEffect(() => {
    // A viewer cannot turn a feature on, so a viewer's visit does not start
    // the 60 days of "New" and does not clear a dot.
    if (!canWrite) return;
    const ids = BOOK_FEATURES.map((f) => f.id);
    recordFirstSeen(ids, localToday());
    // The user now sees these features, so the navbar dot for them goes.
    if (seen) clearDots(bookId, ids);
  }, [bookId, canWrite, seen]);

  if (!canWrite) {
    return <p className="text-sm text-fg-tertiary">Only an editor can change features.</p>;
  }

  return (
    <div className="space-y-4">
      {BOOK_FEATURES.map((feature) => (
        <div key={feature.id} data-feature={feature.id} className="relative">
          {newIds.has(feature.id) && (
            <span
              data-feature-new
              className="absolute right-0 top-4 rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-semibold text-fg-accent"
            >
              New
            </span>
          )}
          {featureBody(feature, bookId, bookName)}
        </div>
      ))}
    </div>
  );
}
