CREATE TABLE "book_members" (
	"book_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "book_members_book_id_user_id_pk" PRIMARY KEY("book_id","user_id"),
	CONSTRAINT "book_members_role_check" CHECK ("book_members"."role" IN ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_by" integer;--> statement-breakpoint
ALTER TABLE "book_members" ADD CONSTRAINT "book_members_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_members" ADD CONSTRAINT "book_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_members_user_id_idx" ON "book_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;