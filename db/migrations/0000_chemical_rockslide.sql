CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"parent_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_investment_cash" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"security_id" integer NOT NULL,
	"opened_transaction_id" integer,
	"closed_transaction_id" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"account_id" integer,
	"security_id" integer NOT NULL,
	"lot_id" integer,
	"action" text NOT NULL,
	"shares_micros" integer NOT NULL,
	"price_micros" integer NOT NULL,
	"fees_cents" integer DEFAULT 0 NOT NULL,
	"split_numerator" integer,
	"split_denominator" integer
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text NOT NULL,
	"subtype" text,
	"counterpoise_account_id" integer,
	"sync_cursor" text,
	"last_synced_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"financial_institution" text NOT NULL,
	"item_id" text NOT NULL,
	"access_token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_transaction_reconciliation" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"plaid_account_link_id" integer NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"date" text NOT NULL,
	"authorized_date" text,
	"amount_cents" integer NOT NULL,
	"name" text NOT NULL,
	"merchant_name" text,
	"original_description" text,
	"pending" boolean DEFAULT false NOT NULL,
	"pending_transaction_id" text,
	"iso_currency_code" text,
	"unofficial_currency_code" text,
	"category_primary" text,
	"category_detailed" text,
	"raw_json" text NOT NULL,
	"resolution_status" text DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"review_metadata_json" text,
	"matched_transaction_id" integer,
	"resolved_at" timestamp,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"name" text NOT NULL,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"days_of_week" text,
	"week_of_month" text,
	"days_of_month" text,
	"start_date" text NOT NULL,
	"end_date" text,
	"next_date" text NOT NULL,
	"auto_create_days_before" integer DEFAULT 0 NOT NULL,
	"template_description" text,
	"payee_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_template_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"recurring_rule_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"security_type" text NOT NULL,
	"fetch_prices" boolean DEFAULT true NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_prices" (
	"security_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"price_date" text NOT NULL,
	"price_micros" integer NOT NULL,
	"source" text,
	CONSTRAINT "security_prices_security_id_price_date_pk" PRIMARY KEY("security_id","price_date")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"date" text NOT NULL,
	"description" text,
	"check_number" text,
	"notes" text,
	"payee_id" integer,
	"is_reconciled" boolean DEFAULT false NOT NULL,
	"recurring_rule_id" integer,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_opened_transaction_id_transactions_id_fk" FOREIGN KEY ("opened_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lots" ADD CONSTRAINT "investment_lots_closed_transaction_id_transactions_id_fk" FOREIGN KEY ("closed_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_splits" ADD CONSTRAINT "investment_splits_lot_id_investment_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."investment_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_token_id_plaid_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."plaid_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_counterpoise_account_id_accounts_id_fk" FOREIGN KEY ("counterpoise_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_tokens" ADD CONSTRAINT "plaid_tokens_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_transaction_reconciliation" ADD CONSTRAINT "plaid_transaction_reconciliation_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_transaction_reconciliation" ADD CONSTRAINT "plaid_transaction_reconciliation_plaid_account_link_id_plaid_accounts_id_fk" FOREIGN KEY ("plaid_account_link_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_transaction_reconciliation" ADD CONSTRAINT "plaid_transaction_reconciliation_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_splits" ADD CONSTRAINT "recurring_template_splits_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_splits" ADD CONSTRAINT "recurring_template_splits_recurring_rule_id_recurring_rules_id_fk" FOREIGN KEY ("recurring_rule_id") REFERENCES "public"."recurring_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_splits" ADD CONSTRAINT "recurring_template_splits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_rule_id_recurring_rules_id_fk" FOREIGN KEY ("recurring_rule_id") REFERENCES "public"."recurring_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_name_book_unique" ON "accounts" USING btree ("name","book_id");--> statement-breakpoint
CREATE INDEX "idx_investment_splits_txn" ON "investment_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_investment_splits_account_txn" ON "investment_splits" USING btree ("account_id","transaction_id");--> statement-breakpoint
CREATE INDEX "idx_investment_splits_security_txn" ON "investment_splits" USING btree ("security_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payees_name_book_unique" ON "payees" USING btree ("name","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_accounts_plaid_account_id_unique" ON "plaid_accounts" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_accounts_counterpoise_account_id_unique" ON "plaid_accounts" USING btree ("counterpoise_account_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_accounts_token" ON "plaid_accounts" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_tokens_item_id_unique" ON "plaid_tokens" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_recon_link_txn_unique" ON "plaid_transaction_reconciliation" USING btree ("plaid_account_link_id","plaid_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_recon_link_matched_txn_unique" ON "plaid_transaction_reconciliation" USING btree ("plaid_account_link_id","matched_transaction_id");--> statement-breakpoint
CREATE INDEX "plaid_recon_link_status_idx" ON "plaid_transaction_reconciliation" USING btree ("plaid_account_link_id","resolution_status","review_reason");--> statement-breakpoint
CREATE INDEX "idx_recurring_rules_active_next" ON "recurring_rules" USING btree ("is_active","next_date");--> statement-breakpoint
CREATE INDEX "idx_recurring_template_splits_rule" ON "recurring_template_splits" USING btree ("recurring_rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "securities_name_symbol_book_unique" ON "securities" USING btree ("name","symbol","book_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_splits_account_txn" ON "transaction_splits" USING btree ("account_id","transaction_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_splits_txn_amount" ON "transaction_splits" USING btree ("transaction_id","amount");--> statement-breakpoint
CREATE INDEX "idx_transactions_date_id" ON "transactions" USING btree ("date","id");--> statement-breakpoint
CREATE INDEX "idx_transactions_payee_date_id" ON "transactions" USING btree ("payee_id","date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username");