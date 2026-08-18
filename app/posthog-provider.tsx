"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "@posthog/react";
import { useEffect } from "react";
import { identifyUser } from "@/lib/posthog-client";
import { apiGet } from "@/lib/api-client";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      defaults: "2025-11-30",
      capture_pageview: false,
    });

    const identifyReturningUser = async () => {
      try {
        const user = await apiGet<{ id?: number }>("/api/auth/me");
        if (user?.id) identifyUser(user.id);
      } catch {
        // Best-effort analytics identification only. This runs on every
        // page load, including for signed-out visitors (who 401 here) — a
        // failure must stay silent rather than interrupt anyone with an
        // error about analytics.
      }
    };

    void identifyReturningUser();
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
