"use client";

import { usePathname, useSearchParams } from "@/lib/navigation";
import { useEffect } from "react";
import posthog from "posthog-js";
import { redactedCaptureUrl } from "@/lib/posthog-url";

export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname && posthog.__loaded) {
      // Never build this URL by hand. The query string carries what the user
      // typed on the search page, so it goes through the redaction helper.
      const url = redactedCaptureUrl(
        window.origin,
        pathname,
        searchParams.toString(),
      );
      posthog.capture("$pageview", { $current_url: url });
    }
  }, [pathname, searchParams]);

  return null;
}
