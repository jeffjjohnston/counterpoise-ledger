ALTER TABLE "investment_splits" DROP CONSTRAINT "investment_splits_lot_id_investment_lots_id_fk";
--> statement-breakpoint
ALTER TABLE "investment_splits" DROP COLUMN "lot_id";