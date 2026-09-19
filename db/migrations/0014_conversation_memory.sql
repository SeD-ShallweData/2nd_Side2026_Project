CREATE TABLE "conversation_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "active_company_id" text,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "conversation_threads_title_ck" CHECK (char_length(btrim("conversation_threads"."title")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "turn_index" integer NOT NULL,
  "company_id" text,
  "answer_type" text NOT NULL,
  "guardrail_status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_turns_index_ck" CHECK ("conversation_turns"."turn_index" > 0),
  CONSTRAINT "conversation_turns_answer_type_ck" CHECK ("conversation_turns"."answer_type" in ('general_guidance','company_context','clarification','insufficient_evidence','refusal','emergency_guidance')),
  CONSTRAINT "conversation_turns_guardrail_status_ck" CHECK ("conversation_turns"."guardrail_status" in ('passed','limited','refused','escalated'))
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "turn_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_messages_role_ck" CHECK ("conversation_messages"."role" in ('user','assistant')),
  CONSTRAINT "conversation_messages_content_ck" CHECK (char_length("conversation_messages"."content") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "conversation_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "turn_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "name" text NOT NULL,
  "category" text,
  "citation" text,
  "organization" text,
  "as_of" text,
  "url" text,
  "document_id" text,
  CONSTRAINT "conversation_sources_position_ck" CHECK ("conversation_sources"."position" >= 0),
  CONSTRAINT "conversation_sources_category_ck" CHECK ("conversation_sources"."category" is null or "conversation_sources"."category" in ('wage','safety','labor_law'))
);
--> statement-breakpoint
CREATE TABLE "conversation_company_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "previous_company_id" text,
  "next_company_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_active_company_id_firms_firm_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_id_conversation_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_company_id_firms_firm_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_sources" ADD CONSTRAINT "conversation_sources_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_company_events" ADD CONSTRAINT "conversation_company_events_conversation_id_conversation_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_company_events" ADD CONSTRAINT "conversation_company_events_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_company_events" ADD CONSTRAINT "conversation_company_events_previous_company_id_firms_firm_id_fk" FOREIGN KEY ("previous_company_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_company_events" ADD CONSTRAINT "conversation_company_events_next_company_id_firms_firm_id_fk" FOREIGN KEY ("next_company_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_threads_owner_activity_idx" ON "conversation_threads" USING btree ("owner_user_id","last_activity_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "conversation_threads_expires_idx" ON "conversation_threads" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "conversation_threads_active_company_idx" ON "conversation_threads" USING btree ("active_company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_idempotency_uq" ON "conversation_turns" USING btree ("conversation_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_sequence_uq" ON "conversation_turns" USING btree ("conversation_id","turn_index");
--> statement-breakpoint
CREATE INDEX "conversation_turns_conversation_created_idx" ON "conversation_turns" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_turn_role_uq" ON "conversation_messages" USING btree ("turn_id","role");
--> statement-breakpoint
CREATE INDEX "conversation_messages_turn_created_idx" ON "conversation_messages" USING btree ("turn_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_sources_turn_position_uq" ON "conversation_sources" USING btree ("turn_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_company_events_turn_uq" ON "conversation_company_events" USING btree ("turn_id");
--> statement-breakpoint
CREATE INDEX "conversation_company_events_conversation_created_idx" ON "conversation_company_events" USING btree ("conversation_id","created_at");
