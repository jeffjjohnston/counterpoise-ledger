import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestTiingoPrices, isTiingoConfigured } from "@/lib/tiingo";

const originalApiKey = process.env.TIINGO_API_KEY;

beforeEach(() => {
  process.env.TIINGO_API_KEY = "test-key";
});

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.TIINGO_API_KEY;
  } else {
    process.env.TIINGO_API_KEY = originalApiKey;
  }
  vi.unstubAllGlobals();
});

describe("isTiingoConfigured", () => {
  it("returns true when TIINGO_API_KEY is set", () => {
    expect(isTiingoConfigured()).toBe(true);
  });

  it("returns false when TIINGO_API_KEY is missing", () => {
    delete process.env.TIINGO_API_KEY;
    expect(isTiingoConfigured()).toBe(false);
  });
});

describe("fetchLatestTiingoPrices", () => {
  it("returns the latest adjusted close per symbol with a YYYY-MM-DD date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { ticker: "vti", date: "2026-07-02T00:00:00.000Z", close: 300.1, adjClose: 299.123456 },
        ],
      })
    );

    const { prices, errors } = await fetchLatestTiingoPrices(["vti"]);

    expect(errors).toEqual([]);
    expect(prices).toEqual([
      { symbol: "VTI", price: 299.123456, date: "2026-07-02" },
    ]);
  });

  it("collects per-symbol errors without failing the whole batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/GOOD/")) {
          return {
            ok: true,
            json: async () => [
              { ticker: "GOOD", date: "2026-07-02T00:00:00.000Z", close: 10, adjClose: 10 },
            ],
          };
        }
        if (url.includes("/EMPTY/")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, statusText: "Not Found" };
      })
    );

    const { prices, errors } = await fetchLatestTiingoPrices(["GOOD", "EMPTY", "BAD"]);

    expect(prices).toEqual([{ symbol: "GOOD", price: 10, date: "2026-07-02" }]);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.symbol).sort()).toEqual(["BAD", "EMPTY"]);
  });

  it("throws when TIINGO_API_KEY is missing", async () => {
    delete process.env.TIINGO_API_KEY;
    await expect(fetchLatestTiingoPrices(["VTI"])).rejects.toThrow(
      /TIINGO_API_KEY/
    );
  });
});
