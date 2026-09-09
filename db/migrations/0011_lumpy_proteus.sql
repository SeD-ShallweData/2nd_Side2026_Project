ALTER TABLE "users" DROP CONSTRAINT "users_role_ck";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_firm_scope_ck";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_firm_id_firms_firm_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "firm_id";