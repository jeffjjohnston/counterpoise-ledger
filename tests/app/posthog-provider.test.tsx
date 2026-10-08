import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { init, identify: vi.fn(), capture: vi.fn() } }));
vi.mock("@posthog/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PostHogProvider } from "@/app/posthog-provider";

describe("PostHogProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    init.mockClear();
  });

  // posthog-js autocapture sends the text of a clicked element. A payee
  // link, an account row and a position row carry names and balances, which
  // guides/posthog-analytics.md says must not leave the instance.
  it("turns autocapture off, so the text of a clicked payee or balance stays on the instance", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    render(
      <PostHogProvider>
        <div />
      </PostHogProvider>
    );
    expect(init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ autocapture: false }));
  });

  it("does not start PostHog without a key", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    render(
      <PostHogProvider>
        <div />
      </PostHogProvider>
    );
    expect(init).not.toHaveBeenCalled();
  });
});
