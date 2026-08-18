import posthog from "posthog-js";

export function identifyUser(userId: number): void {
  if (typeof window === "undefined") return;
  posthog.identify(String(userId));
}

export function resetUser(): void {
  if (typeof window === "undefined") return;
  posthog.reset();
}
