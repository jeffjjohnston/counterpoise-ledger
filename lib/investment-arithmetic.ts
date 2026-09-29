/** Pure JavaScript fallback for values outside the browser WASM i64 contract. */
const MICROS_PRODUCT_PER_CENT = 10_000_000_000n;

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const doubled = numerator * 2n + denominator;
  const divisor = denominator * 2n;
  const quotient = doubled / divisor;
  return doubled < 0n && doubled % divisor !== 0n ? quotient - 1n : quotient;
}

/** Exact micros x micros to cents with JavaScript's half-toward-positive-infinity tie rule. */
export function getInvestmentGrossAmountCents(sharesMicros: number, priceMicros: number): number {
  const shares = BigInt(Math.round(sharesMicros));
  const price = BigInt(Math.round(priceMicros));
  return Number(roundHalfUp(shares * price, MICROS_PRODUCT_PER_CENT));
}
