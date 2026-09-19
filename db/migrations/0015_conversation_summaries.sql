CREATE TABLE "conversation_summaries" (
  "conversation_id" uuid PRIMARY KEY NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summarized_through_sequence" integer DEFAULT 0 NOT NULL,
  "pending_through_sequence" integer,
  "summary_version" text DEFAULT 'extractive-v1' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_summaries_status_ck" CHECK ("conversation_summaries"."status" in ('pending','ready','failed')),
  CONSTRAINT "conversation_summaries_sequence_ck" CHECK ("conversation_summaries"."summarized_through_sequence" >= 0 and ("conversation_summaries"."pending_through_sequence" is null or "conversation_summaries"."pending_through_sequence" > "conversation_summaries"."summarized_through_sequence")),
  CONSTRAINT "conversation_summaries_retry_ck" CHECK ("conversation_summaries"."retry_count" >= 0),
  CONSTRAINT "conversation_summaries_payload_ck" CHECK (jsonb_typeof("conversation_summaries"."summary") = 'object')
);
--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversation_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_summaries_status_updated_idx" ON "conversation_summaries" USING btree ("status","updated_at");
