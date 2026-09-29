import { vi } from "vitest";
import type * as Navigation from "@/lib/navigation";

type NavigationModule = typeof Navigation;

/**
 * A full mock of `@/lib/navigation`. `vi.mock` needs each export that the
 * component under test uses, so the defaults supply all of them. Give only
 * the exports that the test cares about:
 *
 * ```ts
 * vi.mock("@/lib/navigation", async () =>
 *   (await import("@/tests/helpers/navigation")).mockNavigation({
 *     useParams: () => ({ bookId: "1" }),
 *   })
 * );
 * ```
 *
 * `vi.mock` factories are hoisted above the imports, so the factory must
 * import this helper itself.
 */
export function mockNavigation(
  overrides: Partial<Record<keyof NavigationModule, unknown>> = {}
): NavigationModule {
  return {
    Link: ({ href, children, ...props }) => (
      <a href={href} {...props}>
        {children}
      </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/",
    useParams: (() => ({})) as NavigationModule["useParams"],
    useSearchParams: () => new URLSearchParams(),
    // A test gives plain functions and vi.fn() mocks, which do not match the
    // generic signatures.
    ...(overrides as Partial<NavigationModule>),
  };
}
