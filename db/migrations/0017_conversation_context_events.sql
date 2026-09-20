ALTER TABLE "conversation_company_events"
  DROP CONSTRAINT "conversation_company_events_turn_id_conversation_turns_id_fk";

ALTER TABLE "conversation_company_events"
  ALTER COLUMN "turn_id" DROP NOT NULL,
  ADD COLUMN "event_kind" text NOT NULL DEFAULT 'turn';

ALTER TABLE "conversation_company_events"
  ADD CONSTRAINT "conversation_company_events_turn_id_conversation_turns_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "conversation_company_events"
  ADD CONSTRAINT "conversation_company_events_kind_ck"
  CHECK ("event_kind" in ('turn','manual'));
