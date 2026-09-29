import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";
import RootLayout from "@/app/layout";
import { NotFound } from "./NotFound";
import { RouteError } from "./RouteError";

/**
 * The route table of the client. Each page is a separate chunk, which loads
 * when a navigation first reaches it. The book layout is lazy too: it brings
 * the WASM core (about 2 MB), which the login and register pages do not need.
 *
 * The pages stay in `app/`, at the paths that the Next router used, so that
 * a page and its route are easy to find together.
 */

type PageModule = { default: ComponentType };

/** A route whose component is the default export of a module that loads on demand. */
function page(load: () => Promise<PageModule>): Pick<RouteObject, "lazy"> {
  return { lazy: async () => ({ Component: (await load()).default }) };
}

export const routes: RouteObject[] = [
  {
    Component: RootLayout,
    // Nothing renders while the first page chunk loads. The body background
    // of index.html shows, so the page does not flash.
    HydrateFallback: () => null,
    // One error page for all routes. A page chunk that is gone after a
    // deploy causes one reload (see stale-chunk.ts). Without this, React
    // Router shows its default "Unexpected Application Error".
    ErrorBoundary: RouteError,
    children: [
      { index: true, ...page(() => import("@/app/page")) },
      { path: "login", ...page(() => import("@/app/login/page")) },
      { path: "register", ...page(() => import("@/app/register/page")) },
      { path: "account", ...page(() => import("@/app/account/page")) },
      {
        path: "b/:bookId",
        ...page(() => import("@/app/b/[bookId]/layout")),
        children: [
          { index: true, ...page(() => import("@/app/b/[bookId]/page")) },
          { path: "accounts", ...page(() => import("@/app/b/[bookId]/accounts/page")) },
          { path: "payees", ...page(() => import("@/app/b/[bookId]/payees/page")) },
          { path: "payees/:id", ...page(() => import("@/app/b/[bookId]/payees/[id]/page")) },
          { path: "recurring", ...page(() => import("@/app/b/[bookId]/recurring/page")) },
          { path: "recurring/:id", ...page(() => import("@/app/b/[bookId]/recurring/[id]/page")) },
          { path: "reports", ...page(() => import("@/app/b/[bookId]/reports/page")) },
          {
            path: "reports/income-statement",
            ...page(() => import("@/app/b/[bookId]/reports/income-statement/page")),
          },
          {
            path: "reports/realized-gains",
            ...page(() => import("@/app/b/[bookId]/reports/realized-gains/page")),
          },
          { path: "search", ...page(() => import("@/app/b/[bookId]/search/page")) },
          { path: "securities", ...page(() => import("@/app/b/[bookId]/securities/page")) },
          { path: "securities/:id", ...page(() => import("@/app/b/[bookId]/securities/[id]/page")) },
          { path: "sync", ...page(() => import("@/app/b/[bookId]/sync/page")) },
          { path: "sync/tokens", ...page(() => import("@/app/b/[bookId]/sync/tokens/page")) },
          { path: "transactions", ...page(() => import("@/app/b/[bookId]/transactions/page")) },
        ],
      },
      { path: "*", Component: NotFound },
    ],
  },
];

export const router = createBrowserRouter(routes);
