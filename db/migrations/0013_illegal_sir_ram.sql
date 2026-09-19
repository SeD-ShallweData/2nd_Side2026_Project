ALTER TABLE "worksite_tips" DROP CONSTRAINT "worksite_tips_category_ck";--> statement-breakpoint
ALTER TABLE "worksite_tips" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
UPDATE "worksite_tips" SET "category" = 'safety' WHERE "category" = 'worksite_tip';--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD COLUMN "status" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
CREATE INDEX "worksite_tips_status_submitted_idx" ON "worksite_tips" USING btree ("status","submitted_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_status_ck" CHECK ("worksite_tips"."status" in ('received','in_progress','completed'));--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_category_ck" CHECK ("worksite_tips"."category" in ('wage','safety'));
