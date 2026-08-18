UPDATE "sessions" SET "token" = encode(sha256("token"::bytea), 'hex');--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_token_unique" TO "sessions_token_hash_unique";