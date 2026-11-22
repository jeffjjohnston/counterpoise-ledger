"use client";

import { SettingsPage } from "@/components/settings/SettingsPage";
import { useBookId } from "@/hooks/useBookId";

/** `/b/:bookId/settings`: the book, account and device settings. */
export default function Page() {
  const bookId = useBookId();
  return <SettingsPage bookId={bookId} />;
}
