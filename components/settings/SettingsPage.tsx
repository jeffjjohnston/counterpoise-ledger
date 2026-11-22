"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@/lib/navigation";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { DeviceSettings } from "@/components/settings/DeviceSettings";
import { BookFeaturesSettings } from "@/components/settings/BookFeaturesSettings";
import { BookGeneralSettings } from "@/components/settings/BookGeneralSettings";
import { BookMembersSettings } from "@/components/settings/BookMembersSettings";
import { DeleteBookSettings } from "@/components/settings/DeleteBookSettings";
import { NewFeatureDot } from "@/components/settings/NewFeatureDot";
import { useActiveSection } from "@/components/settings/useActiveSection";
import { useNewFeatureDot } from "@/components/settings/useNewFeatureDot";
import { useBookRole } from "@/components/BookRoleProvider";
import { cn } from "@/lib/utils";

type MenuGroup = { title: string; items: Array<{ id: string; label: string }> };

const ACCOUNT_GROUP: MenuGroup = {
  title: "Account",
  items: [
    { id: "account", label: "Profile" },
    { id: "security", label: "Password" },
    { id: "api-keys", label: "API keys" },
    { id: "connected-apps", label: "Connected apps" },
  ],
};

const DEVICE_GROUP: MenuGroup = { title: "This device", items: [{ id: "device", label: "Appearance" }] };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="bg-surface rounded-lg border border-border shadow-soft p-6 sm:p-8 space-y-6">
      <h2 className="text-lg font-bold text-fg">{heading}</h2>
      {children}
    </div>
  );
}

/** The dot on "Features" in the side menu. It goes when the user reads the
 * Features section, as the navbar dot does. */
function FeaturesMenuDot({ bookId, canWrite }: { bookId: string; canWrite: boolean }) {
  return useNewFeatureDot(bookId, canWrite) ? <NewFeatureDot /> : null;
}

// A user action of one of these types ends the hold on a linked section.
const USER_INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
// Pixels. A smaller move of the held section is rounding, not a user scroll.
const HOLD_TOLERANCE = 2;

/**
 * The one settings page. In a book (`bookId` set) it shows the book group
 * first. Without a book it shows only the Account and This device groups.
 * Each section has an id, so a link can open the page at that section.
 */
export function SettingsPage({ bookId }: { bookId?: string }) {
  const { currentBook, canWrite, isOwner, status } = useBookRole();
  const book = bookId ? currentBook : null;
  const bookGroup: MenuGroup | null = book
    ? {
        title: "This book",
        items: [
          { id: "features", label: "Features" },
          { id: "general", label: "General" },
          { id: "members", label: "Members" },
          ...(isOwner ? [{ id: "danger", label: "Delete" }] : []),
        ],
      }
    : null;
  const groups = bookGroup ? [bookGroup, ACCOUNT_GROUP, DEVICE_GROUP] : [ACCOUNT_GROUP, DEVICE_GROUP];

  const { active, pin } = useActiveSection(groups.flatMap((group) => group.items.map((item) => item.id)));
  const content = useRef<HTMLDivElement>(null);

  // A link can open the page at a section. The book sections render only
  // after the book loads, so scroll when they exist.
  const ready = !bookId || book !== null || status !== "loading";
  useEffect(() => {
    if (!ready) return;
    const id = window.location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (!target) return;
    // Where the hold put the section, as a distance from the viewport top,
    // and the content size at that time.
    let held = { top: 0, width: 0, height: 0 };
    const contentSize = () => {
      const box = content.current?.getBoundingClientRect();
      return { width: box?.width ?? 0, height: box?.height ?? 0 };
    };
    const hold = () => {
      target.scrollIntoView();
      held = { top: target.getBoundingClientRect().top, ...contentSize() };
    };
    hold();
    pin(id);
    if (typeof ResizeObserver === "undefined" || !content.current) return;
    // The content above the section can load later and move the section
    // down. Go to the section again on each change of the content height,
    // until the user does something.
    const observer = new ResizeObserver(hold);
    observer.observe(content.current);
    const stop = () => {
      observer.disconnect();
      for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, stop, { capture: true });
      document.removeEventListener("scroll", scrolled, { capture: true });
    };
    // A scrollbar drag sends none of the input events in some browsers, but
    // it sends scroll events. The hold's own scroll leaves the section where
    // the hold put it. Thus a scroll that moved the section is the user's.
    const scrolled = () => {
      // A scroll event comes before the observer in a frame. If the content
      // size changed, the content moved the section and the observer will
      // hold it again.
      const size = contentSize();
      if (size.width !== held.width || size.height !== held.height) return;
      if (Math.abs(target.getBoundingClientRect().top - held.top) > HOLD_TOLERANCE) stop();
    };
    for (const type of USER_INPUT_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });
    // Capture phase: a scroll event from a scroll container does not bubble.
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return stop;
  }, [ready, pin]);
  return (
    <div className="min-h-screen bg-surface-secondary">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:grid lg:grid-cols-[12rem_1fr] lg:gap-8">
        <aside className="mb-6 lg:mb-0">
          {!bookId && (
            <Link href="/" className="block mb-4 text-sm text-fg-accent font-medium">
              Back to books
            </Link>
          )}
          <h1 className="text-2xl font-bold text-fg mb-4">Settings</h1>
          <nav aria-label="Settings sections" className="lg:sticky lg:top-24 flex flex-wrap gap-x-6 gap-y-4 lg:block lg:space-y-4">
            {groups.map((group) => (
              <div key={group.title}>
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">{group.title}</p>
                <ul className="mt-1 space-y-1">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#${item.id}`}
                        onClick={(event) => {
                          // A plain hash link is a history POP to the router, and its
                          // scroll restoration then puts back an old position. Scroll
                          // here, and change only the hash of the current entry.
                          event.preventDefault();
                          document.getElementById(item.id)?.scrollIntoView();
                          pin(item.id);
                          window.history.replaceState(window.history.state, "", `#${item.id}`);
                        }}
                        aria-current={active === item.id ? "location" : undefined}
                        className={cn(
                          "inline-flex items-center gap-1.5 text-sm hover:text-fg",
                          active === item.id ? "font-semibold text-fg" : "text-fg-secondary"
                        )}
                      >
                        {item.label}
                        {item.id === "features" && book && <FeaturesMenuDot bookId={String(book.id)} canWrite={canWrite} />}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <div ref={content} className="space-y-6 min-w-0">
          {book && (
            <Group heading={`This book: ${book.name}`}>
              <Section id="features" title="Features">
                <BookFeaturesSettings key={book.id} bookId={String(book.id)} bookName={book.name} canWrite={canWrite} seen={active === "features"} />
              </Section>
              <Section id="general" title="General">
                <BookGeneralSettings book={book} />
              </Section>
              <section id="members" className="scroll-mt-24">
                <BookMembersSettings bookId={String(book.id)} />
              </section>
              {isOwner && (
                <Section id="danger" title="Delete this book">
                  <DeleteBookSettings book={book} />
                </Section>
              )}
            </Group>
          )}
          <Group heading="Account: applies to all your books">
            <AccountSettings />
          </Group>
          <Group heading="This device: stored in this browser">
            <DeviceSettings />
          </Group>
        </div>
      </div>
    </div>
  );
}
