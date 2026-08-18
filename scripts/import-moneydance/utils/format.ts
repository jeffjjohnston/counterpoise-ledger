/**
 * Date and amount conversion utilities
 */

/**
 * Convert Moneydance date format (YYYYMMDD) to ISO format (YYYY-MM-DD)
 */
export function convertDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) {
    throw new Error(`Invalid date format: ${yyyymmdd}`);
  }

  const year = yyyymmdd.substring(0, 4);
  const month = yyyymmdd.substring(4, 6);
  const day = yyyymmdd.substring(6, 8);

  // Validate date components
  const yearNum = parseInt(year);
  const monthNum = parseInt(month);
  const dayNum = parseInt(day);

  if (yearNum < 1900 || yearNum > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  if (dayNum < 1 || dayNum > 31) {
    throw new Error(`Invalid day: ${day}`);
  }

  return `${year}-${month}-${day}`;
}

/**
 * Convert cents to integer amount (keeping cents)
 * Moneydance stores amounts as cents, which matches Counterpoise
 */
export function convertAmount(cents: string | number): number {
  const amount = typeof cents === "string" ? parseInt(cents) : cents;
  if (isNaN(amount)) {
    throw new Error(`Invalid amount: ${cents}`);
  }
  return amount;
}

/**
 * Check if a boolean field is true
 * Handles various boolean formats: "y", "yes", "1", "n", "no", "0"
 */
export function isTrue(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower === "y" || lower === "yes" || lower === "1";
}

/**
 * Check if a single Moneydance status value indicates reconciled
 * "X" = reconciled, " " (space) or missing = unreconciled
 */
export function isReconciledStatus(stat: string | undefined): boolean {
  if (!stat) return false;
  return stat.trim().toUpperCase() === "X";
}

/**
 * Check if a Moneydance transaction is reconciled by checking both the
 * parent stat field and all split-level N.stat fields.
 * Moneydance stores reconciliation per-split: when an account is reconciled,
 * only that account's side of the transaction is marked "X". Since Counterpoise
 * has a single isReconciled per transaction, we treat it as reconciled if ANY
 * side has been reconciled.
 */
export function isTransactionReconciled(txn: Record<string, unknown>): boolean {
  if (isReconciledStatus(txn.stat as string | undefined)) return true;
  for (const key of Object.keys(txn)) {
    if (/^\d+\.stat$/.test(key) && isReconciledStatus(txn[key] as string | undefined)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize description/payee name
 * Must match the normalization in @/lib/payees.ts to avoid duplicates
 */
export function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    // Normalize various quote characters to straight apostrophe
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'");
}

/**
 * Normalize optional text fields, returning null for blank values
 */
export function normalizeOptionalText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Format date for display
 */
export function formatDateForDisplay(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Convert price from decimal string to micros
 * Used for security prices (csnap.relrt)
 * Note: Moneydance stores prices as rates (inverse of price), so we invert them
 */
export function convertPriceToMicros(priceStr: string): number {
  const rate = parseFloat(priceStr);
  if (isNaN(rate) || rate === 0) {
    throw new Error(`Invalid price rate: ${priceStr}`);
  }
  // Moneydance stores relrt as the inverse of the price (rate = 1/price)
  // So we need to invert it: price = 1/rate
  const price = 1 / rate;
  return Math.round(price * 1_000_000);
}

/**
 * Convert shares from Moneydance format to Counterpoise micros
 * Moneydance: shares * 100,000
 * Counterpoise: shares * 1,000,000
 */
export function convertSharesMicros(sharesMicros: string | number): number {
  const shares = typeof sharesMicros === "string" ? parseInt(sharesMicros) : sharesMicros;
  if (isNaN(shares)) {
    throw new Error(`Invalid shares: ${sharesMicros}`);
  }
  // Convert from Moneydance format (shares * 100,000) to Counterpoise format (shares * 1,000,000)
  return shares * 10;
}

/**
 * Calculate price per share from transaction amounts
 * @param pamt - Cash amount in cents (absolute value)
 * @param samt - Share quantity in micros (absolute value)
 * @returns Price in micros
 */
export function calculatePriceFromTransaction(pamt: number, samt: number): number {
  if (samt === 0) {
    throw new Error("Cannot calculate price with zero shares");
  }
  // pamt is in cents, samt is in micros
  // Price per share in dollars = (pamt cents / 100) / (samt micros / 1,000,000)
  // Price per share in micros = price in dollars * 1,000,000
  // Simplified: (pamt * 10,000,000,000) / samt
  const price = Math.round((Math.abs(pamt) * 10_000_000_000) / Math.abs(samt));
  return price;
}

/**
 * Parse stock split ratio into numerator/denominator
 * @param oldShrs - Shares before split (e.g., "2")
 * @param newShrs - Shares after split (e.g., "1")
 * @param ratio - Optional ratio field from Moneydance (used when oldShrs=newShrs)
 * @returns Simplified numerator and denominator
 */
export function parseStockSplitRatio(
  oldShrs: string,
  newShrs: string,
  ratio?: string
): { numerator: number; denominator: number } {
  const old = parseInt(oldShrs);
  const newVal = parseInt(newShrs);

  if (isNaN(old) || isNaN(newVal) || old <= 0 || newVal <= 0) {
    throw new Error(`Invalid split ratio: ${oldShrs}:${newShrs}`);
  }

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const simplify = (numerator: number, denominator: number) => {
    const divisor = gcd(numerator, denominator);
    return {
      numerator: numerator / divisor,
      denominator: denominator / divisor,
    };
  };

  const ratioVal = ratio ? parseFloat(ratio) : NaN;
  const hasRatio = Number.isFinite(ratioVal) && ratioVal > 0;
  const isClose = (a: number, b: number) => Math.abs(a - b) < 1e-6;

  // If oldShrs equals newShrs (e.g., both "1"), use ratio field if provided
  // This handles cases where Moneydance uses ratio as the authoritative source
  if (old === newVal && hasRatio && !isClose(ratioVal, 1)) {
    // ratio > 1 means forward split (e.g., 2.0 = 2-for-1)
    // ratio < 1 means reverse split (e.g., 0.5 = 1-for-2)
    if (ratioVal >= 1) {
      return simplify(Math.round(ratioVal), 1);
    }
    return simplify(1, Math.round(1 / ratioVal));
  }

  if (hasRatio && old !== newVal) {
    const ratioNewOld = newVal / old;
    const ratioOldNew = old / newVal;
    if (
      (isClose(ratioVal, ratioNewOld) || isClose(ratioVal, ratioOldNew)) &&
      Math.abs(ratioVal - ratioOldNew) < Math.abs(ratioVal - ratioNewOld)
    ) {
      // Moneydance sometimes swaps old/new for forward splits. Use ratio to detect.
      return simplify(old, newVal);
    }
  }

  // Split is newShrs-for-oldShrs (e.g., 1-for-2 reverse split)
  return simplify(newVal, old);
}
