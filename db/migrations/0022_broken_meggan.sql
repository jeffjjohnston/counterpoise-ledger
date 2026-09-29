CREATE TABLE "typesafe_aggregates" (
	"book_id" integer PRIMARY KEY NOT NULL,
	"counts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "typesafe_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"reconciliation_id" integer NOT NULL,
	"evaluation_id" integer,
	"action" text NOT NULL,
	"transaction_id" integer,
	"suggestion_visible" boolean DEFAULT false NOT NULL,
	"accepted_suggestion" boolean DEFAULT false NOT NULL,
	"active_review_ms" integer,
	"decided_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "typesafe_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"reconciliation_id" integer NOT NULL,
	"link_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"attempt" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"choice" text,
	"probabilities" jsonb,
	"confidence" jsonb,
	"usage" jsonb,
	"error_code" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"displayed_at" timestamp,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "typesafe_quotas" (
	"book_id" integer NOT NULL,
	"day" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "typesafe_quotas_book_id_day_pk" PRIMARY KEY("book_id","day")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "typesafe_reconciliation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "typesafe_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "typesafe_aggregates" ADD CONSTRAINT "typesafe_aggregates_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typesafe_decisions" ADD CONSTRAINT "typesafe_decisions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typesafe_decisions" ADD CONSTRAINT "typesafe_decisions_evaluation_id_typesafe_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."typesafe_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typesafe_evaluations" ADD CONSTRAINT "typesafe_evaluations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typesafe_quotas" ADD CONSTRAINT "typesafe_quotas_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "typesafe_decision_book" ON "typesafe_decisions" USING btree ("book_id","reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "typesafe_evaluation_input" ON "typesafe_evaluations" USING btree ("book_id","fingerprint");--> statement-breakpoint
CREATE INDEX "typesafe_evaluation_age" ON "typesafe_evaluations" USING btree ("started_at");