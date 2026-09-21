ALTER TABLE "conversation_summaries" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD COLUMN "lease_expires_at" timestamp with time zone;