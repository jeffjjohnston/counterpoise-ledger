import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("posthog-node", () => {
  class MockPostHog {
    capture = vi.fn();
    shutdown = vi.fn();
  }
  return { PostHog: MockPostHog };
});

describe("posthog-server", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_key");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://posthog.test.com");
  });

  it("returns null when NEXT_PUBLIC_POSTHOG_KEY is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { getPostHogServer } = await import("@/lib/posthog-server");
    expect(getPostHogServer()).toBeNull();
  });

  it("returns a PostHog client when configured", async () => {
    const { getPostHogServer } = await import("@/lib/posthog-server");
    const client = getPostHogServer();
    expect(client).not.toBeNull();
    expect(client!.capture).toBeDefined();
  });

  it("returns the same instance on subsequent calls", async () => {
    const { getPostHogServer } = await import("@/lib/posthog-server");
    const client1 = getPostHogServer();
    const client2 = getPostHogServer();
    expect(client1).toBe(client2);
  });

  it("captureEvent is a no-op when client is null", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { captureEvent } = await import("@/lib/posthog-server");
    captureEvent(1, "test_event", { foo: "bar" });
  });

  it("captureEvent calls capture with correct args", async () => {
    const { getPostHogServer, captureEvent } = await import("@/lib/posthog-server");
    captureEvent(42, "transaction_created", { splitCount: 3 });
    const client = getPostHogServer();
    expect(client!.capture).toHaveBeenCalledWith({
      distinctId: "42",
      event: "transaction_created",
      properties: { splitCount: 3 },
    });
  });
});
