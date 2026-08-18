ALTER TABLE "investment_splits" ALTER COLUMN "shares_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "investment_splits" ALTER COLUMN "price_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "security_prices" ALTER COLUMN "price_micros" SET DATA TYPE bigint;