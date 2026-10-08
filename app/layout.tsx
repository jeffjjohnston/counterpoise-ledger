import { Suspense } from "react";
import { Outlet, ScrollRestoration } from "react-router";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { PostHogProvider } from "@/app/posthog-provider";
import { PostHogPageview } from "@/app/posthog-pageview";
import { UpdateBanner } from "@/client/UpdateBanner";

/**
 * The root route of `client/routes.tsx`. The document head, the theme script
 * and the body classes are in `index.html`.
 */
export default function RootLayout() {
  return (
    <PostHogProvider>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      <ThemeProvider>
        <ToastProvider>
          <Outlet />
          <UpdateBanner />
        </ToastProvider>
      </ThemeProvider>
      {/* A navigation goes to the top of the page, and Back and Forward
          restore the position, as with the Next router. */}
      <ScrollRestoration />
    </PostHogProvider>
  );
}
