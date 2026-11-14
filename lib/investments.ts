/**
 * The shapes of the investment rows that the API sends. The Rust server
 * calculates them (`aggregate_positions()` and
 * `aggregate_market_values_by_account()` in rust-api/core/src/investments.rs).
 */

/** One row of `GET /api/b/[bookId]/investments/positions`. */
export type PositionSummary = {
  securityId: number;
  securityName: string;
  securitySymbol: string;
  sharesMicros: number;
  costBasisCents: number;
  priceMicros: number | null;
  priceDate: string | null;
  marketValueCents: number | null;
};

/** The market value of one investment account. */
export type AccountMarketValue = {
  accountId: number;
  marketValueCents: number;
};
