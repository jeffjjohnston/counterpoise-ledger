DELETE FROM "investment_lots";
--> statement-breakpoint
CREATE TABLE "investment_lot_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"lot_id" integer NOT NULL,
	"sell_split_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"shares_micros" bigint NOT NULL,
	"basis_cents" integer NOT NULL,
	"proceeds_cents" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "account_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "acquired_date" text NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "opened_split_id" integer;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "original_shares_micros" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "original_basis_cents" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "remaining_shares_micros" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD COLUMN "remaining_basis_cents" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_lot_allocations" ADD CONSTRAINT "investment_lot_allocations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lot_allocations" ADD CONSTRAINT "investment_lot_allocations_lot_id_investment_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."investment_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lot_allocations" ADD CONSTRAINT "investment_lot_allocations_sell_split_id_investment_splits_id_fk" FOREIGN KEY ("sell_split_id") REFERENCES "public"."investment_splits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lot_allocations" ADD CONSTRAINT "investment_lot_allocations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_lot_allocations_lot" ON "investment_lot_allocations" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_lot_allocations_sell" ON "investment_lot_allocations" USING btree ("sell_split_id");--> statement-breakpoint
CREATE INDEX "idx_lot_allocations_book_txn" ON "investment_lot_allocations" USING btree ("book_id","transaction_id");--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_opened_split_id_investment_splits_id_fk" FOREIGN KEY ("opened_split_id") REFERENCES "public"."investment_splits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_investment_lots_pair" ON "investment_lots" USING btree ("book_id","account_id","security_id");--> statement-breakpoint
CREATE INDEX "idx_investment_lots_open" ON "investment_lots" USING btree ("security_id","remaining_shares_micros");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_investment_lots_opened_split_unique" ON "investment_lots" USING btree ("opened_split_id");