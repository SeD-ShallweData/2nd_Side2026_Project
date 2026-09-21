ALTER TABLE "conversation_requests" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "conversation_requests"
SET "lease_token" = gen_random_uuid(),
    "lease_expires_at" = now() + interval '120 seconds'
WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "conversation_requests_pending_lease_idx" ON "conversation_requests" USING btree ("status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_lease_ck" CHECK (("conversation_requests"."status" = 'pending' and "conversation_requests"."lease_token" is not null and "conversation_requests"."lease_expires_at" is not null) or ("conversation_requests"."status" <> 'pending' and "conversation_requests"."lease_token" is null and "conversation_requests"."lease_expires_at" is null));
