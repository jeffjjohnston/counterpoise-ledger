-- Book-scoped composite foreign keys on the core ledger relations. Each child
-- row must agree with its parent on book_id, so a cross-book reference becomes
-- impossible rather than merely unlikely.
--
-- STATEMENT ORDER IS LOAD-BEARING. A foreign key must point to a unique
-- constraint that already exists, so every ADD CONSTRAINT ... UNIQUE runs
-- before the foreign keys that reference it. drizzle-kit generate emits the
-- foreign keys first, which PostgreSQL rejects with "there is no unique
-- constraint matching given keys". If you regenerate this file, put the
-- statements back in this order.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_parent_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "investment_splits" DROP CONSTRAINT "investment_splits_transaction_id_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "investment_splits" DROP CONSTRAINT "investment_splits_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "investment_splits" DROP CONSTRAINT "investment_splits_security_id_securities_id_fk";
--> statement-breakpoint
ALTER TABLE "recurring_template_splits" DROP CONSTRAINT "recurring_template_splits_recurring_rule_id_recurring_rules_id_fk";
--> statement-breakpoint
ALTER TABLE "security_prices" DROP CONSTRAINT "security_prices_security_id_securities_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction_splits" DROP CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction_splits" DROP CONSTRAINT "transaction_splits_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_book_id_id_unique" UNIQUE("book_id","id");
--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_book_id_id_unique" UNIQUE("book_id","id");
--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_book_id_id_unique" UNIQUE("book_id","id");
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_book_id_id_unique" UNIQUE("book_id","id");
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_book_parent_fk" FOREIGN KEY ("book_id","parent_id") REFERENCES "public"."accounts"("book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_book_transaction_fk" FOREIGN KEY ("book_id","transaction_id") REFERENCES "public"."transactions"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_book_account_fk" FOREIGN KEY ("book_id","account_id") REFERENCES "public"."accounts"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_book_security_fk" FOREIGN KEY ("book_id","security_id") REFERENCES "public"."securities"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_template_splits" ADD CONSTRAINT "recurring_template_splits_book_rule_fk" FOREIGN KEY ("book_id","recurring_rule_id") REFERENCES "public"."recurring_rules"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_book_security_fk" FOREIGN KEY ("book_id","security_id") REFERENCES "public"."securities"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_book_transaction_fk" FOREIGN KEY ("book_id","transaction_id") REFERENCES "public"."transactions"("book_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_book_account_fk" FOREIGN KEY ("book_id","account_id") REFERENCES "public"."accounts"("book_id","id") ON DELETE no action ON UPDATE no action;
