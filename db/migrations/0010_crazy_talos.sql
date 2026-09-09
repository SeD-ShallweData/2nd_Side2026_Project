CREATE TABLE "worksite_tip_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tip_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worksite_tip_attachments_media_type_ck" CHECK ("worksite_tip_attachments"."media_type" in ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "worksite_tip_attachments_size_ck" CHECK ("worksite_tip_attachments"."size_bytes" > 0 and "worksite_tip_attachments"."size_bytes" <= 5242880),
	CONSTRAINT "worksite_tip_attachments_sha256_ck" CHECK ("worksite_tip_attachments"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "worksite_tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"category" text DEFAULT 'worksite_tip' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"firm_id" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worksite_tips_category_ck" CHECK ("worksite_tips"."category" = 'worksite_tip')
);
--> statement-breakpoint
ALTER TABLE "worksite_tip_attachments" ADD CONSTRAINT "worksite_tip_attachments_tip_id_worksite_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."worksite_tips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worksite_tip_attachments_storage_key_uq" ON "worksite_tip_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "worksite_tip_attachments_tip_idx" ON "worksite_tip_attachments" USING btree ("tip_id");--> statement-breakpoint
CREATE INDEX "worksite_tips_reporter_idx" ON "worksite_tips" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "worksite_tips_firm_idx" ON "worksite_tips" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "worksite_tips_submitted_idx" ON "worksite_tips" USING btree ("submitted_at" DESC NULLS LAST);