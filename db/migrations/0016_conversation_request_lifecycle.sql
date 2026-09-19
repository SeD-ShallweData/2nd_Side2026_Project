ALTER TABLE "conversation_messages" ADD COLUMN "message_index" smallint;
--> statement-breakpoint
UPDATE "conversation_messages" SET "message_index" = CASE "role" WHEN 'user' THEN 1 ELSE 2 END;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "message_index" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sequence_ck" CHECK ("message_index" in (1, 2));
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_turn_sequence_uq" ON "conversation_messages" USING btree ("turn_id","message_index");
--> statement-breakpoint
CREATE TABLE "conversation_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "request_id" text NOT NULL,
  "conversation_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "response_payload" jsonb,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "conversation_requests_status_ck" CHECK ("status" in ('pending','completed','failed','cancelled')),
  CONSTRAINT "conversation_requests_payload_ck" CHECK ("response_payload" is null or jsonb_typeof("response_payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_conversation_id_conversation_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_requests_owner_request_uq" ON "conversation_requests" USING btree ("owner_user_id","request_id");
--> statement-breakpoint
CREATE INDEX "conversation_requests_conversation_status_idx" ON "conversation_requests" USING btree ("conversation_id","status");
