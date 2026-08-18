-- Backfill investment_splits.account_id for dividend/capGain/fee rows that were
-- created through the UI/MCP write path before the account was derived from the
-- investment-cash leg's parent. The Moneydance importer already stored the
-- brokerage account, so only manually-entered rows have a null account_id here.
-- Resolve each null row to the parent of its transaction's investment-cash leg.
-- The cash leg and its parent are required to be in the same book as the split,
-- and the parent must itself be an investment account; rows that fail these
-- checks (plain cash leg, cross-book parent, non-investment parent) stay null.
-- Correlations to the UPDATE target (isp) live in WHERE: Postgres does not
-- allow referencing the target table inside the FROM clause's JOIN conditions.
UPDATE "investment_splits" AS isp
SET "account_id" = parent."id"
FROM "transaction_splits" ts
JOIN "accounts" cash
  ON cash."id" = ts."account_id"
  AND cash."is_investment_cash" = true
JOIN "accounts" parent
  ON parent."id" = cash."parent_id"
  AND parent."subtype" = 'investment'
WHERE isp."account_id" IS NULL
  AND isp."action" IN ('dividend', 'capGain', 'fee')
  AND ts."transaction_id" = isp."transaction_id"
  AND cash."book_id" = isp."book_id"
  AND parent."book_id" = isp."book_id";
