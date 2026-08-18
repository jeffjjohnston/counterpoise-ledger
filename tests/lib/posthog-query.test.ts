import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeHogQLString,
  getPostHogQueryConfig,
  parsePropertiesColumn,
  runHogQLQuery,
} from "@/lib/posthog-query";

describe("posthog-query", () => {
  beforeEach(() => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test_key");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://posthog.test.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("getPostHogQueryConfig", () => {
    it("returns host and api key when configured", () => {
      expect(getPostHogQueryConfig()).toEqual({
        host: "https://posthog.test.com",
        apiKey: "phx_test_key",
      });
    });

    it("returns null when the personal api key is missing", () => {
      vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "");
      expect(getPostHogQueryConfig()).toBeNull();
    });

    it("returns null when the host is missing", () => {
      vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "");
      expect(getPostHogQueryConfig()).toBeNull();
    });
  });

  describe("escapeHogQLString", () => {
    it("escapes single quotes", () => {
      expect(escapeHogQLString("o'brien")).toBe("o\\'brien");
    });

    it("escapes backslashes", () => {
      expect(escapeHogQLString("a\\b")).toBe("a\\\\b");
    });

    it("leaves plain strings untouched", () => {
      expect(escapeHogQLString("$pageview")).toBe("$pageview");
    });
  });

  describe("parsePropertiesColumn", () => {
    it("parses a JSON string into an object", () => {
      expect(parsePropertiesColumn('{"bookId": 1}')).toEqual({ bookId: 1 });
    });

    it("returns non-string values unchanged", () => {
      expect(parsePropertiesColumn({ already: "parsed" })).toEqual({ already: "parsed" });
      expect(parsePropertiesColumn(null)).toBeNull();
    });

    it("returns the raw string when it is not valid JSON", () => {
      expect(parsePropertiesColumn("not json")).toBe("not json");
    });
  });

  describe("runHogQLQuery", () => {
    it("POSTs a HogQL query to the project query endpoint and returns results", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          columns: ["event", "count()"],
          results: [["$pageview", 653]],
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await runHogQLQuery("SELECT event, count() FROM events GROUP BY event");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://posthog.test.com/api/projects/@current/query/");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer phx_test_key",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init.body as string)).toEqual({
        query: {
          kind: "HogQLQuery",
          query: "SELECT event, count() FROM events GROUP BY event",
        },
      });
      expect(result).toEqual({
        columns: ["event", "count()"],
        results: [["$pageview", 653]],
      });
    });

    it("throws when PostHog is not configured", async () => {
      vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "");
      await expect(runHogQLQuery("SELECT 1")).rejects.toThrow(
        "PostHog not configured (POSTHOG_PERSONAL_API_KEY, NEXT_PUBLIC_POSTHOG_HOST)"
      );
    });

    it("throws with status details and response body on a failed response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => '{"detail":"invalid key"}',
        }))
      );

      await expect(runHogQLQuery("SELECT 1")).rejects.toThrow(
        'PostHog API error: 401 Unauthorized {"detail":"invalid key"}'
      );
    });

    it("omits the body (and trailing space) when the response body is empty", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "",
        }))
      );

      await expect(runHogQLQuery("SELECT 1")).rejects.toThrow(
        /PostHog API error: 500 Internal Server Error$/
      );
    });

    it("defaults columns to an empty array when missing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ results: [] }),
        }))
      );

      const result = await runHogQLQuery("SELECT 1");
      expect(result).toEqual({ columns: [], results: [] });
    });
  });
});
