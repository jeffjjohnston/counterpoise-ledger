/**
 * Data validation utilities
 */

import type { MoneydanceTransaction } from "../types";

/**
 * Validate that transaction splits balance to zero
 */
export function validateSplitBalance(txn: MoneydanceTransaction): {
  valid: boolean;
  total: number;
  splits: Array<{ index: number; amount: number }>;
} {
  const splits: Array<{ index: number; amount: number }> = [];

  // Collect all split amounts (using samt = split amount from split's perspective)
  for (const key in txn) {
    if (key.match(/^\d+\.samt$/)) {
      const index = parseInt(key.split(".")[0]);
      const amount = parseInt(txn[key] as string);
      if (!isNaN(amount)) {
        splits.push({ index, amount });
      }
    }
  }

  const total = splits.reduce((sum, split) => sum + split.amount, 0);

  return {
    valid: total === 0,
    total,
    splits,
  };
}

/**
 * Check if transaction has all required fields
 */
export function validateTransaction(txn: MoneydanceTransaction): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!txn.id) {
    errors.push("Missing transaction ID");
  }

  if (!txn.dt) {
    errors.push("Missing transaction date");
  }

  if (!txn.acctid && !txn["0.acctid"]) {
    errors.push("Missing account ID");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract split data from transaction
 */
export function extractSplits(txn: MoneydanceTransaction): Array<{
  index: number;
  id: string;
  acctid: string;
  desc: string;
  amount: number;
  tags?: string;
}> {
  const splits: Array<{
    index: number;
    id: string;
    acctid: string;
    desc: string;
    amount: number;
    tags?: string;
  }> = [];

  // Find all split indexes
  const indexes = new Set<number>();
  for (const key in txn) {
    if (key.match(/^\d+\./)) {
      const index = parseInt(key.split(".")[0]);
      indexes.add(index);
    }
  }

  // Extract data for each split
  for (const index of Array.from(indexes).sort()) {
    const id = txn[`${index}.id`] as string;
    const acctid = txn[`${index}.acctid`] as string;
    const desc = (txn[`${index}.desc`] as string) || "";
    const samt = txn[`${index}.samt`] as string | undefined; // Use samt (split amount from split's perspective)
    const tags = txn[`${index}.tags`] as string | undefined;

    if (acctid && samt) {
      splits.push({
        index,
        id,
        acctid,
        desc,
        amount: parseInt(samt),
        tags,
      });
    }
  }

  return splits;
}
