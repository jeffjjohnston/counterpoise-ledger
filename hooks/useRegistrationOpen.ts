"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";

/** How long the pages wait for the answer before they show registration as closed. */
export const REGISTRATION_STATUS_TIMEOUT_MS = 5000;

/**
 * Whether the login and register pages offer registration. The Rust route
 * `GET /api/auth/registration-open` decides: it reads `REGISTRATION_ENABLED`,
 * or in bootstrap mode it is open until the first user exists. The answer is
 * `null` until the response arrives, so that a closed instance does not show
 * a registration link for a moment. When the request fails or does not
 * complete in time, the answer is `false`: the register route refuses anyway
 * when the server does not answer.
 *
 * This is presentation only. `POST /api/auth/register` is the security
 * boundary.
 */
export function useRegistrationOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let unmounted = false;
    // A stalled request must not leave the pages without an answer.
    const timeout = setTimeout(() => controller.abort(), REGISTRATION_STATUS_TIMEOUT_MS);
    apiGet<{ open?: unknown }>("/api/auth/registration-open", { signal: controller.signal })
      .then((body) => setOpen(body?.open === true))
      .catch((cause: unknown) => {
        if (unmounted) return;
        console.warn("[counterpoise] Registration status unavailable; showing registration as closed", cause);
        setOpen(false);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      unmounted = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return open;
}
