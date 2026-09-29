/**
 * The one module through which the client uses the router. Import `Link`,
 * `useRouter`, `usePathname`, `useParams` and `useSearchParams` from here,
 * never from `react-router`. ESLint refuses that import in all other files,
 * except the route table (`client/`) and the two layouts.
 *
 * Each export gives only the part of a router API that the app uses, so the
 * router is easy to replace:
 *
 * - `useRouter()` gives `push` and `replace` only, with the `scroll` option.
 * - `useSearchParams()` is read only.
 * - `Link` takes an `href` string and the attributes of an anchor.
 */

import { useMemo, type AnchorHTMLAttributes } from "react";
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router";

export interface NavigateOptions {
  /**
   * `false` keeps the scroll position. By default the page goes to the top,
   * as after a click on a link. `<ScrollRestoration />` in the root layout
   * does the scroll.
   */
  scroll?: boolean;
}

export interface AppRouter {
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
}

export type SearchParams = Pick<URLSearchParams, "get" | "getAll" | "has" | "toString">;

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};

export function Link({ href, ...props }: LinkProps) {
  return <RouterLink to={href} {...props} />;
}

/** The router object is stable across renders, so an effect can depend on it. */
export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href, options) => {
        void navigate(href, { preventScrollReset: options?.scroll === false });
      },
      replace: (href, options) => {
        void navigate(href, { replace: true, preventScrollReset: options?.scroll === false });
      },
    }),
    [navigate]
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

/** The dynamic segments of the current route, for example `{ bookId: "5" }`. */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useRouterParams() as T;
}

export function useSearchParams(): SearchParams {
  return useRouterSearchParams()[0];
}
