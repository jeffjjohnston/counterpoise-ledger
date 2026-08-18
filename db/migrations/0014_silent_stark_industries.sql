DROP INDEX "idx_transactions_date_id";--> statement-breakpoint
CREATE INDEX "idx_transactions_book_date_id" ON "transactions" USING btree ("book_id","date","id");