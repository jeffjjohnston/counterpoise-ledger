ALTER TABLE "recurring_template_splits" DROP CONSTRAINT "recurring_template_splits_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "recurring_template_splits" ADD CONSTRAINT "recurring_template_splits_book_account_fk" FOREIGN KEY ("book_id","account_id") REFERENCES "public"."accounts"("book_id","id") ON DELETE no action ON UPDATE no action;