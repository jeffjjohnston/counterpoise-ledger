"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useBookId } from "@/hooks/useBookId";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { resetUser } from "@/lib/posthog-client";
import { ReportIssueModal } from "@/components/ReportIssueModal";
import { PriceEntryPill } from "@/components/layout/PriceEntryPill";
import { JobHealthIndicator } from "@/components/layout/JobHealthIndicator";
import { SYNC_QUEUE_CHANGED_EVENT } from "@/lib/events";
import { apiGet, apiPost, apiPut, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";

type Book = {
  id: number;
  name: string;
  upcomingDays: number;
};

type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
};

export function BookNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const bookId = useBookId();
  const toast = useToast();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const logoSrc = resolvedTheme === "dark" ? "/favicon-dark-64x64.png" : "/favicon-64x64.png";
  const [books, setBooks] = useState<Book[]>([]);
  const [currentBook, setCurrentBook] = useState<Book | null>(null);
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [upcomingDays, setUpcomingDays] = useState(30);
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const bookMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const prefix = `/b/${bookId}`;

  const primaryNavItems = [
    { href: `${prefix}`, label: "Dashboard" },
    { href: `${prefix}/transactions`, label: "Transactions" },
    { href: `${prefix}/recurring`, label: "Recurring" },
    { href: `${prefix}/securities`, label: "Securities" },
    { href: `${prefix}/sync`, label: "Sync" },
  ];

  const moreNavItems = [
    { href: `${prefix}/accounts`, label: "Accounts" },
    { href: `${prefix}/payees`, label: "Payees" },
  ];

  const reportsNavItems: NavItem[] = [
    { href: `${prefix}/reports/income-statement`, label: "Income Statement" },
    { href: `${prefix}/reports/realized-gains`, label: "Realized Gains" },
    { href: `${prefix}/reports`, label: "Custom Report", exact: true },
  ];

  useEffect(() => {
    apiGet<Book[]>("/api/books")
      .then((data) => {
        setBooks(data);
        const current = data.find((b) => b.id === parseInt(bookId));
        setCurrentBook(current ?? null);
        if (current) setUpcomingDays(current.upcomingDays);
      })
      .catch(() => {});
  }, [bookId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bookMenuRef.current && !bookMenuRef.current.contains(event.target as Node)) {
        setShowBookMenu(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowMoreMenu(false);
        setShowBookMenu(false);
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const isActive = (item: NavItem | string) => {
    const href = typeof item === "string" ? item : item.href;
    const exact = typeof item === "string" ? false : item.exact;
    if (href === prefix || exact) return pathname === href;
    return pathname.startsWith(href);
  };

  const handleLogout = async () => {
    try {
      await apiPost("/api/auth/logout");
    } catch (err) {
      // Logout failed (network failure or non-2xx): leave the user where
      // they are so they can retry rather than navigating away while still
      // authenticated server-side. A non-2xx means the server session may
      // still be valid, so don't tell the user they're logged out
      // (resetUser + navigate) when they might not be — telling someone
      // they're logged out when they aren't is worse than telling them the
      // logout failed.
      toast.error(toMessage(err, "Failed to sign out"));
      return;
    }
    resetUser();
    router.push("/login");
  };

  const fetchSyncPendingCount = useCallback(() => {
    if (!bookId) return;
    apiGet<{ count: number }>(`/api/b/${bookId}/sync/pending-count`)
      .then((data) => {
        setSyncPendingCount(data.count ?? 0);
      })
      .catch(() => {});
  }, [bookId]);

  useEffect(() => {
    if (!bookId) return;

    fetchSyncPendingCount();
    const interval = setInterval(fetchSyncPendingCount, 60_000);
    return () => clearInterval(interval);
  }, [bookId, fetchSyncPendingCount]);

  useEffect(() => {
    const handler = () => fetchSyncPendingCount();
    window.addEventListener(SYNC_QUEUE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SYNC_QUEUE_CHANGED_EVENT, handler);
  }, [fetchSyncPendingCount]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Close the mobile menu when the viewport leaves the mobile range.
  //
  // The menu and everything that dismisses it are `lg:hidden`: crossing to
  // desktop width (an iPad rotating to landscape) removes the overlay, its
  // backdrop, and the hamburger itself. The scroll lock below keys off menu
  // state alone, so a menu left open would strand `overflow: hidden` on a
  // desktop-width page with nothing on screen to clear it — recoverable only
  // by rotating back and closing the menu. useIsMobile shares MOBILE_BREAKPOINT
  // with the `lg:` classes, so this cannot drift from the CSS that hides them.
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!isMobile) {
      setMobileMenuOpen(false);
    }
  }, [isMobile]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [mobileMenuOpen]);

  const allMobileNavItems = [
    ...primaryNavItems,
    ...moreNavItems,
    ...reportsNavItems,
    { href: `${prefix}/search`, label: "Search" },
  ];

  return (
    <>
      <nav className="bg-surface border-b border-border">
        <div className="px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14 lg:h-16">
            <div className="flex items-center">
              <Link href="/" className="flex items-center gap-2 flex-shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoSrc} alt="" className="w-7 h-7 lg:w-8 lg:h-8" />
                <span className="text-lg lg:text-xl font-bold text-fg hidden sm:inline" title={`Counterpoise v${process.env.NEXT_PUBLIC_APP_VERSION}`}>Counterpoise</span>
              </Link>

              {/* Book switcher */}
              <div className="relative ml-2 sm:ml-4" ref={bookMenuRef}>
                <button
                  onClick={() => {
                    setShowBookMenu(!showBookMenu);
                    setShowUserMenu(false);
                    setShowMoreMenu(false);
                  }}
                  aria-label="Open book menu"
                  aria-haspopup="true"
                  aria-expanded={showBookMenu}
                  className="flex items-center gap-1 px-2 sm:px-3 py-1.5 text-sm font-medium text-fg-secondary bg-surface-tertiary rounded-md hover:bg-surface-tertiary/80 transition-colors max-w-[8rem] sm:max-w-[10rem]"
                >
                  <span className="truncate">{currentBook?.name || "Loading..."}</span>
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showBookMenu && (
                  <div className="absolute left-0 mt-1 w-56 bg-surface-elevated border border-border rounded-lg shadow-lg z-50">
                    {books.map((book) => {
                      const isCurrentBook = book.id === parseInt(bookId);
                      return (
                        <Link
                          key={book.id}
                          href={`/b/${book.id}`}
                          aria-current={isCurrentBook ? "page" : undefined}
                          className={cn(
                            "flex items-center justify-between px-4 py-2 text-sm hover:bg-surface-tertiary",
                            isCurrentBook
                              ? "font-medium text-fg-accent bg-accent-subtle"
                              : "text-fg-secondary"
                          )}
                          onClick={() => setShowBookMenu(false)}
                        >
                          <span>{book.name}</span>
                          {isCurrentBook && (
                            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </Link>
                      );
                    })}
                    <div className="border-t border-border">
                      <Link
                        href="/"
                        className="block px-4 py-2 text-sm text-fg-tertiary hover:bg-surface-tertiary"
                        onClick={() => setShowBookMenu(false)}
                      >
                        Manage books...
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right cluster: price pill + breakpoint-specific controls */}
            <div className="flex items-center gap-2 self-stretch">
              <PriceEntryPill bookId={bookId} />
              <JobHealthIndicator />

              {/* Desktop nav links — hidden on mobile */}
              <div className="hidden lg:flex items-stretch self-stretch">
              <div className="flex items-stretch">
                {primaryNavItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "self-stretch flex items-center px-3 text-sm font-medium transition-colors border-b-2",
                      isActive(item)
                        ? "border-fg-accent text-fg-accent"
                        : "border-transparent text-fg-secondary hover:text-fg hover:border-border"
                    )}
                  >
                    {item.label}
                    {item.label === "Sync" && syncPendingCount > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-accent text-fg-on-accent text-xs font-semibold">
                        {syncPendingCount > 99 ? "99+" : syncPendingCount}
                      </span>
                    )}
                  </Link>
                ))}

                {/* More dropdown */}
                <div className="relative self-stretch flex items-stretch" ref={moreMenuRef}>
                  <button
                    onClick={() => {
                      setShowMoreMenu(!showMoreMenu);
                      setShowBookMenu(false);
                      setShowUserMenu(false);
                    }}
                    aria-expanded={showMoreMenu}
                    aria-haspopup="true"
                    className={cn(
                      "self-stretch flex items-center gap-1 px-3 text-sm font-medium transition-colors border-b-2",
                      [...moreNavItems, ...reportsNavItems].some((item) => isActive(item))
                        ? "border-fg-accent text-fg-accent"
                        : "border-transparent text-fg-secondary hover:text-fg hover:border-border"
                    )}
                  >
                    More
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showMoreMenu && (
                    <div className="absolute top-full right-0 mt-0 w-48 bg-surface-elevated border border-border rounded-lg shadow-lg z-50">
                      {moreNavItems.map((item) => (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={cn(
                            "block px-4 py-2 text-sm",
                            isActive(item)
                              ? "font-medium text-fg-accent bg-accent-subtle"
                              : "text-fg-secondary hover:bg-surface-tertiary"
                          )}
                          onClick={() => setShowMoreMenu(false)}
                        >
                          {item.label}
                        </Link>
                      ))}
                      <div className="border-t border-border">
                        <span className="block px-4 pt-2 pb-1 text-xs font-medium text-fg-tertiary uppercase tracking-wider">Reports</span>
                        {reportsNavItems.map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                              "block px-4 py-2 text-sm",
                              isActive(item)
                                ? "font-medium text-fg-accent bg-accent-subtle"
                                : "text-fg-secondary hover:bg-surface-tertiary"
                            )}
                            onClick={() => setShowMoreMenu(false)}
                          >
                            {item.label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Search */}
                <Link
                  href={`${prefix}/search`}
                  className={cn(
                    "self-stretch flex items-center px-3 transition-colors border-b-2",
                    isActive(`${prefix}/search`)
                      ? "border-fg-accent text-fg-accent"
                      : "border-transparent text-fg-secondary hover:text-fg hover:border-border"
                  )}
                  aria-label="Search"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </Link>
              </div>

              {/* Controls — icon buttons, no nav border treatment */}
              <div className="flex items-center gap-1 ml-2">
                {/* Report issue */}
                <button
                  onClick={() => setShowReportModal(true)}
                  aria-label="Report an issue"
                  className="p-2 text-fg-secondary hover:text-fg rounded-md hover:bg-surface-tertiary transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </button>

                {/* User menu */}
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => {
                      setShowUserMenu(!showUserMenu);
                      setShowBookMenu(false);
                      setShowMoreMenu(false);
                    }}
                    aria-label="Open user menu"
                    aria-haspopup="true"
                    aria-expanded={showUserMenu}
                    className="p-2 text-fg-secondary hover:text-fg rounded-md hover:bg-surface-tertiary transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </button>
                  {showUserMenu && (
                    <div className="absolute right-0 mt-1 w-44 bg-surface-elevated border border-border rounded-lg shadow-lg z-50">
                      <button
                        onClick={() => {
                          setShowUserMenu(false);
                          setShowAccountModal(true);
                        }}
                        className="block w-full text-left px-4 py-2 text-sm text-fg-secondary hover:bg-surface-tertiary"
                      >
                        Settings
                      </button>
                      <button
                        onClick={handleLogout}
                        className="block w-full text-left px-4 py-2 text-sm text-fg-secondary hover:bg-surface-tertiary rounded-lg"
                      >
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Mobile controls — visible on mobile only */}
            <div className="flex lg:hidden items-center gap-1">
              <button
                onClick={() => setShowReportModal(true)}
                aria-label="Report an issue"
                className="p-2 text-fg-secondary hover:text-fg rounded-md hover:bg-surface-tertiary transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </button>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
                aria-expanded={mobileMenuOpen}
                className="p-2 text-fg-secondary hover:text-fg rounded-md hover:bg-surface-tertiary transition-colors"
              >
                {mobileMenuOpen ? (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile slide-out menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" aria-modal="true">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="fixed top-14 right-0 bottom-0 w-64 bg-surface border-l border-border shadow-xl overflow-y-auto animate-mobile-menu-in">
            <div className="py-2">
              {allMobileNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "block px-6 py-3 text-sm font-medium transition-colors",
                    isActive(item)
                      ? "text-fg-accent bg-accent-subtle border-l-2 border-fg-accent"
                      : "text-fg-secondary hover:bg-surface-tertiary"
                  )}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <span className="flex items-center justify-between">
                    {item.label}
                    {item.label === "Sync" && syncPendingCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-accent text-fg-on-accent text-xs font-semibold">
                        {syncPendingCount > 99 ? "99+" : syncPendingCount}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
            <div className="border-t border-border py-2">
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  setShowAccountModal(true);
                }}
                className="block w-full text-left px-6 py-3 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary"
              >
                Settings
              </button>
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  // handleLogout now catches its own errors; it cannot
                  // reject.
                  void handleLogout();
                }}
                className="block w-full text-left px-6 py-3 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal isOpen={showAccountModal} onClose={() => setShowAccountModal(false)} title="Settings" size="sm">
        <div className="space-y-6">
          <section>
            <Select
              id="theme-setting"
              label="Theme"
              value={theme}
              onChange={(event) => setTheme(event.target.value as "light" | "dark" | "system")}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
            />
          </section>

          <section className="pt-4 border-t border-border">
            <Input
              id="upcoming-days"
              label="Upcoming recurring days"
              type="number"
              min={1}
              max={365}
              value={upcomingDays}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 365) {
                  setUpcomingDays(val);
                }
              }}
              onBlur={() => {
                if (!currentBook) return;
                apiPut(`/api/books/${bookId}`, {
                  name: currentBook.name,
                  upcomingDays,
                }).catch(() => {});
              }}
            />
            <p className="mt-1 text-xs text-fg-tertiary">
              Number of days into the future to show recurring transactions (1–365).
            </p>
          </section>

          <section className="pt-4 border-t border-border">
            <h3 className="text-sm font-semibold text-fg">Security</h3>
            <p className="mt-1 text-sm text-fg-tertiary">Manage your password from the account page.</p>
            <Link
              href="/account"
              className="inline-flex mt-3 text-sm font-medium text-fg-accent hover:text-fg-accent"
              onClick={() => setShowAccountModal(false)}
            >
              Open account page
            </Link>
          </section>
        </div>
      </Modal>

      <ReportIssueModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSuccess={() => {
          setShowReportModal(false);
          toast.success("Issue reported — thank you!");
        }}
      />
    </>
  );
}
