"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/accounts", label: "Accounts" },
  { href: "/payees", label: "Payees" },
  { href: "/securities", label: "Securities" },
  { href: "/recurring", label: "Recurring" },
  { href: "/sync", label: "Sync" },
];

export function Navbar() {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const logoSrc = resolvedTheme === "dark" ? "/favicon-dark-64x64.png" : "/favicon-64x64.png";

  return (
    <nav className="bg-surface border-b border-border">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoSrc} alt="" className="w-8 h-8" />
              <span className="text-xl font-bold text-fg" title={`Counterpoise v${process.env.NEXT_PUBLIC_APP_VERSION}`}>Counterpoise</span>
            </Link>
          </div>
          <div className="flex items-center gap-1">
            {/* Nav links — stretch to fill h-16 for border-b-2 */}
            <div className="flex items-stretch">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "self-stretch flex items-center px-4 text-sm font-medium transition-colors border-b-2",
                    pathname === item.href
                      ? "border-fg-accent text-fg-accent"
                      : "border-transparent text-fg-secondary hover:text-fg hover:border-border"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
}
