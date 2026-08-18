/**
 * Tiingo end-of-day price fetching, shared by the manual Update Prices flow
 * (/api/b/[bookId]/security-prices/tiingo) and the price-sync cron
 * (/api/cron/price-sync).
 */

type TiingoResponse = {
  ticker: string;
  date: string;
  close: number;
  adjClose: number;
}[];

export type TiingoLatestPrice = {
  symbol: string;
  price: number;
  date: string;
};

export type TiingoSymbolError = {
  symbol: string;
  error: string;
};

export function isTiingoConfigured(): boolean {
  return Boolean(process.env.TIINGO_API_KEY);
}

/**
 * Fetch the most recent end-of-day adjusted close for each symbol.
 * Failures are collected per symbol rather than failing the batch.
 */
export async function fetchLatestTiingoPrices(
  symbols: string[]
): Promise<{ prices: TiingoLatestPrice[]; errors: TiingoSymbolError[] }> {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) {
    throw new Error("TIINGO_API_KEY environment variable not configured");
  }

  const results = await Promise.allSettled(
    symbols.map(async (symbol): Promise<TiingoLatestPrice> => {
      const url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?token=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch price for ${symbol}: ${response.statusText}`);
      }

      const data: TiingoResponse = await response.json();

      if (!data || data.length === 0) {
        throw new Error(`No price data available for ${symbol}`);
      }

      // Most recent price is the first element
      const latestPrice = data[0];

      return {
        symbol: symbol.toUpperCase(),
        price: latestPrice.adjClose,
        date: latestPrice.date.split("T")[0], // Convert to YYYY-MM-DD format
      };
    })
  );

  const prices: TiingoLatestPrice[] = [];
  const errors: TiingoSymbolError[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      prices.push(result.value);
    } else {
      errors.push({
        symbol: symbols[index],
        error: result.reason?.message || "Unknown error",
      });
    }
  });

  return { prices, errors };
}
