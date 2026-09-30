ALTER TABLE "prompt_versions" DROP CONSTRAINT "prompt_versions_name_ck";--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "content_ko" text;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD COLUMN "source_language" text;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD COLUMN "title_ko" text;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD COLUMN "body_ko" text;--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD COLUMN "translation_status" text DEFAULT 'not_needed' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_content_ko_ck" CHECK ("conversation_messages"."content_ko" is null or char_length("conversation_messages"."content_ko") between 1 and 20000);--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_locale_ck" CHECK ("conversation_messages"."locale" is null or "conversation_messages"."locale" in ('en','zh','vi','th'));--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_name_ck" CHECK ("prompt_versions"."name" in ('chat/system','inspector/system','rewrite/system','translate/system'));--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_translation_status_ck" CHECK ("worksite_tips"."translation_status" in ('not_needed','translated','failed'));--> statement-breakpoint
ALTER TABLE "worksite_tips" ADD CONSTRAINT "worksite_tips_source_language_ck" CHECK ("worksite_tips"."source_language" is null or "worksite_tips"."source_language" ~ '^[a-z]{2,3}$');