ALTER TABLE "typesafe_decisions" ADD COLUMN "proposal_payee_kept" boolean;--> statement-breakpoint
ALTER TABLE "typesafe_decisions" ADD COLUMN "proposal_category_kept" boolean;--> statement-breakpoint
ALTER TABLE "typesafe_evaluations" ADD COLUMN "answers" jsonb;