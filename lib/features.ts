/**
 * The optional features of a book. The settings page shows them at the top
 * of the book group, and the navbar shows a dot when one of them is new and
 * the user can turn it on.
 *
 * "New" lasts NEW_FOR_DAYS from the first time this browser sees the
 * feature, not from a release date. An install that upgrades late still
 * shows the badge. When storage is not available, nothing is new.
 */

/** `entrySuggestionsEnabled` is the second switch of AI suggestions. */
export type BookFeatureState = { enabled: boolean; configured: boolean; entrySuggestionsEnabled?: boolean };

export type BookFeature = {
  id: "typesafe" | "weekly-review";
  title: string;
  /** The GET route that gives at least `{ enabled, configured }`. */
  settingsUrl: (bookId: string) => string;
};

export const BOOK_FEATURES: readonly BookFeature[] = [
  { id: "typesafe", title: "AI suggestions", settingsUrl: (bookId) => `/api/b/${bookId}/settings/typesafe` },
  { id: "weekly-review", title: "Weekly review", settingsUrl: (bookId) => `/api/b/${bookId}/settings/weekly-review` },
];

export const NEW_FOR_DAYS = 60;

const FIRST_SEEN_KEY = "counterpoise:feature-first-seen";
const DOT_CLEARED_KEY = "counterpoise:feature-dot-cleared";

/** clearDots sends this window event, so the navbar dot reads again. */
export const FEATURE_DOTS_EVENT = "counterpoise:feature-dots";

/** True for a `storage` event that can change a dot. Another tab of this
 * browser sends it. A null key means that the tab cleared all storage. */
export function isFeatureStorageEvent(event: StorageEvent): boolean {
  return event.key === null || event.key === FIRST_SEEN_KEY || event.key === DOT_CLEARED_KEY;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** The stored JSON value. Text that is not JSON counts as no value, so that
 * the next write replaces it. Throws only when storage is not available. */
function readJson(key: string): unknown {
  const text = localStorage.getItem(key);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readFirstSeen(): Record<string, string> {
  const value = readJson(FIRST_SEEN_KEY);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/** True while `today` is fewer than NEW_FOR_DAYS after the first sight of
 * `id`. A feature with no first sight is new. This function writes nothing,
 * so a render can call it: recordFirstSeen starts the count. */
export function isFeatureNew(id: string, today: string): boolean {
  try {
    const first = readFirstSeen()[id];
    return first === undefined || dayNumber(today) - dayNumber(first) < NEW_FOR_DAYS;
  } catch {
    return false;
  }
}

/** Records `today` as the first sight of each id that has none. Call it from
 * an effect, and only for a user who can turn the features on. */
export function recordFirstSeen(ids: string[], today: string): void {
  try {
    const seen = readFirstSeen();
    const unseen = ids.filter((id) => !seen[id]);
    if (unseen.length === 0) return;
    for (const id of unseen) seen[id] = today;
    localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // No storage: nothing is new.
  }
}

function readCleared(): string[] {
  const value = readJson(DOT_CLEARED_KEY);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function isDotCleared(bookId: string, id: string): boolean {
  try {
    return readCleared().includes(`${bookId}:${id}`);
  } catch {
    return false;
  }
}

/** Records that the user saw these features of the book, so their dot goes. */
export function clearDots(bookId: string, ids: string[]): void {
  try {
    const before = readCleared();
    const cleared = new Set(before);
    for (const id of ids) cleared.add(`${bookId}:${id}`);
    if (cleared.size === before.length) return;
    localStorage.setItem(DOT_CLEARED_KEY, JSON.stringify([...cleared]));
    window.dispatchEvent(new Event(FEATURE_DOTS_EVENT));
  } catch {
    // No storage: the dot stays, which is safe.
  }
}

/** True when one or more switches of the feature are on. */
export function isFeatureOn(state: BookFeatureState): boolean {
  return state.enabled || state.entrySuggestionsEnabled === true;
}

export function shouldShowDot(args: {
  isNew: boolean;
  cleared: boolean;
  state: BookFeatureState;
  canWrite: boolean;
}): boolean {
  const { isNew, cleared, state, canWrite } = args;
  return isNew && !cleared && !isFeatureOn(state) && state.configured && canWrite;
}

/** Today in the browser's zone, as `YYYY-MM-DD`. */
export function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
