import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("posthog-js", () => ({
  default: {
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

import posthog from "posthog-js";
import { identifyUser, resetUser } from "@/lib/posthog-client";

describe("posthog-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("identifyUser", () => {
    it("calls posthog.identify with stringified userId", () => {
      identifyUser(42);
      expect(posthog.identify).toHaveBeenCalledWith("42");
    });
  });

  describe("resetUser", () => {
    it("calls posthog.reset", () => {
      resetUser();
      expect(posthog.reset).toHaveBeenCalledOnce();
    });
  });
});
