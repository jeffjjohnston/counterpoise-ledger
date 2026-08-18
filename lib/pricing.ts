const PRICE_SCALE = 1_000_000;

export function formatPriceMicros(priceMicros: number): string {
  const dollars = priceMicros / PRICE_SCALE;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(dollars);
}

export function parsePriceMicros(value: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) return 0;
  return Math.round(parsed * PRICE_SCALE);
}
