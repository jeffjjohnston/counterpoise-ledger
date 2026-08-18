ALTER TABLE "plaid_tokens" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "plaid_tokens" ADD COLUMN "last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "plaid_accounts" DROP COLUMN "sync_cursor";--> statement-breakpoint
ALTER TABLE "plaid_accounts" DROP COLUMN "last_synced_at";