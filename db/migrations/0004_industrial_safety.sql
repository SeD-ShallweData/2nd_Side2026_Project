CREATE SCHEMA "industrial_safety";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "industrial_safety" FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE "industrial_safety"."cell_label_datasets" (
	"label_dataset_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."cell_label_datasets_label_dataset_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_run_id" bigint NOT NULL,
	"dataset_code" text NOT NULL,
	"source_system" text NOT NULL,
	"time_basis" text NOT NULL,
	"target_definition" text NOT NULL,
	"approval_year_inference" text NOT NULL,
	"label_maturity_window" text,
	"record_unit" text NOT NULL,
	"complete_through_week_start" date,
	"workplace_identifier_available" boolean NOT NULL,
	"is_unique_accident_event_count" boolean NOT NULL,
	"validated_workplace_probability_available" boolean NOT NULL,
	"artifact_path" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"expected_row_count" bigint NOT NULL,
	"loaded_row_count" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_label_datasets_run_code_uq" UNIQUE("source_run_id","dataset_code"),
	CONSTRAINT "cell_label_datasets_time_basis_ck" CHECK ("industrial_safety"."cell_label_datasets"."time_basis" in ('occurrence_week','approval_week')),
	CONSTRAINT "cell_label_datasets_sha_ck" CHECK ("industrial_safety"."cell_label_datasets"."artifact_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cell_label_datasets_rows_ck" CHECK ("industrial_safety"."cell_label_datasets"."expected_row_count" >= 0 and ("industrial_safety"."cell_label_datasets"."loaded_row_count" is null or "industrial_safety"."cell_label_datasets"."loaded_row_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."cell_week_labels" (
	"label_dataset_id" bigint NOT NULL,
	"week_start" date NOT NULL,
	"sido" text NOT NULL,
	"industry_big" text NOT NULL,
	"label_available" boolean NOT NULL,
	"first_care_approval_record_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_week_labels_pk" PRIMARY KEY("label_dataset_id","week_start","sido","industry_big"),
	CONSTRAINT "cell_week_labels_week_ck" CHECK (extract(isodow from "industrial_safety"."cell_week_labels"."week_start") = 1),
	CONSTRAINT "cell_week_labels_availability_ck" CHECK (("industrial_safety"."cell_week_labels"."label_available" and "industrial_safety"."cell_week_labels"."first_care_approval_record_count" is not null and "industrial_safety"."cell_week_labels"."first_care_approval_record_count" >= 0) or (not "industrial_safety"."cell_week_labels"."label_available" and "industrial_safety"."cell_week_labels"."first_care_approval_record_count" is null))
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."cell_week_predictions" (
	"run_id" bigint NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"data_as_of" timestamp with time zone NOT NULL,
	"snapshot_month" date NOT NULL,
	"available_from" timestamp with time zone,
	"availability_basis" text NOT NULL,
	"population_reconstructed" boolean NOT NULL,
	"snapshot_age_days" integer NOT NULL,
	"sido" text NOT NULL,
	"industry_big" text NOT NULL,
	"workplace_count" bigint NOT NULL,
	"workers" double precision NOT NULL,
	"exposure_workers" double precision NOT NULL,
	"population_cell_missing" boolean NOT NULL,
	"cell_total_expected_approved_record_count" double precision NOT NULL,
	"challenger_expected_approved_record_count" double precision,
	"challenger_nb_alpha" double precision,
	"challenger_model_version" text,
	"baseline_oof_expected_approved_record_count" double precision,
	"challenger_oof_expected_approved_record_count" double precision,
	"working_cell_probability_at_least_one_approval_record" double precision NOT NULL,
	"cell_count_p05" bigint NOT NULL,
	"cell_count_p95" bigint NOT NULL,
	"cell_count_distribution" text NOT NULL,
	"cell_nb_alpha" double precision NOT NULL,
	"prediction_regime" text NOT NULL,
	"cell_model_calibration_status" text NOT NULL,
	"label_vintage_replay_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_week_predictions_pk" PRIMARY KEY("run_id","week_start","sido","industry_big"),
	CONSTRAINT "cell_week_predictions_week_ck" CHECK (extract(isodow from "industrial_safety"."cell_week_predictions"."week_start") = 1 and "industrial_safety"."cell_week_predictions"."week_end" = "industrial_safety"."cell_week_predictions"."week_start" + 6),
	CONSTRAINT "cell_week_predictions_population_ck" CHECK ("industrial_safety"."cell_week_predictions"."workplace_count" >= 0 and "industrial_safety"."cell_week_predictions"."workers" >= 0 and "industrial_safety"."cell_week_predictions"."exposure_workers" >= 0),
	CONSTRAINT "cell_week_predictions_probability_ck" CHECK ("industrial_safety"."cell_week_predictions"."working_cell_probability_at_least_one_approval_record" between 0 and 1),
	CONSTRAINT "cell_week_predictions_interval_ck" CHECK ("industrial_safety"."cell_week_predictions"."cell_count_p05" >= 0 and "industrial_safety"."cell_week_predictions"."cell_count_p95" >= "industrial_safety"."cell_week_predictions"."cell_count_p05")
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."firm_links" (
	"firm_link_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."firm_links_firm_link_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"link_run_id" bigint NOT NULL,
	"workplace_snapshot_id" bigint NOT NULL,
	"candidate_rank" smallint NOT NULL,
	"firm_id" text,
	"candidate_state" text NOT NULL,
	"decision_status" text NOT NULL,
	"match_method" text NOT NULL,
	"confidence_tier" text NOT NULL,
	"confidence_score" double precision,
	"source_key_unique" boolean DEFAULT false NOT NULL,
	"target_key_unique" boolean DEFAULT false NOT NULL,
	"source_key_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_key_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_links_rank_uq" UNIQUE("link_run_id","workplace_snapshot_id","candidate_rank"),
	CONSTRAINT "firm_links_candidate_identity_uq" UNIQUE NULLS NOT DISTINCT("link_run_id","workplace_snapshot_id","firm_id"),
	CONSTRAINT "firm_links_candidate_state_ck" CHECK ("industrial_safety"."firm_links"."candidate_state" in ('matched_candidate','ambiguous_candidate','unmatched')),
	CONSTRAINT "firm_links_decision_status_ck" CHECK ("industrial_safety"."firm_links"."decision_status" in ('auto_accepted','pending_review','human_accepted','human_rejected','not_applicable')),
	CONSTRAINT "firm_links_candidate_rank_ck" CHECK ("industrial_safety"."firm_links"."candidate_rank" between 1 and 100),
	CONSTRAINT "firm_links_confidence_score_ck" CHECK ("industrial_safety"."firm_links"."confidence_score" is null or "industrial_safety"."firm_links"."confidence_score" between 0 and 1),
	CONSTRAINT "firm_links_auto_accept_ck" CHECK ("industrial_safety"."firm_links"."decision_status" <> 'auto_accepted' or ("industrial_safety"."firm_links"."firm_id" is not null and "industrial_safety"."firm_links"."candidate_state" = 'matched_candidate' and "industrial_safety"."firm_links"."match_method" = 'exact_name_masked_business_registration' and "industrial_safety"."firm_links"."source_key_unique" and "industrial_safety"."firm_links"."target_key_unique"))
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."pipeline_run_dependencies" (
	"run_id" bigint NOT NULL,
	"dependency_role" text NOT NULL,
	"upstream_run_id" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_run_dependencies_pk" PRIMARY KEY("run_id","dependency_role","upstream_run_id"),
	CONSTRAINT "pipeline_run_dependencies_not_self_ck" CHECK ("industrial_safety"."pipeline_run_dependencies"."run_id" <> "industrial_safety"."pipeline_run_dependencies"."upstream_run_id"),
	CONSTRAINT "pipeline_run_dependencies_role_ck" CHECK ("industrial_safety"."pipeline_run_dependencies"."dependency_role" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."pipeline_runs" (
	"run_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."pipeline_runs_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_kind" text NOT NULL,
	"publication_scope" text NOT NULL,
	"pipeline_name" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"contract_version" text NOT NULL,
	"model_name" text,
	"model_version" text,
	"population_tier" text,
	"scenario_id" text,
	"target_definition" text,
	"approval_year_inference" text,
	"label_maturity_window" text,
	"calibration_status" text,
	"probability_status" text,
	"risk_value_type" text,
	"priority_reference_population" text,
	"target_week_start_min" date,
	"target_week_start_max" date,
	"primary_artifact_path" text NOT NULL,
	"primary_artifact_sha256" text NOT NULL,
	"artifact_bundle" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_fingerprint" text NOT NULL,
	"expected_row_count" bigint NOT NULL,
	"loaded_row_count" bigint,
	"status" text DEFAULT 'registered' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"quality_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_generated_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	CONSTRAINT "pipeline_runs_fingerprint_uq" UNIQUE("run_fingerprint"),
	CONSTRAINT "pipeline_runs_kind_ck" CHECK ("industrial_safety"."pipeline_runs"."run_kind" in ('cell_prediction','cell_label','workplace_prediction','workplace_snapshot','firm_link')),
	CONSTRAINT "pipeline_runs_status_ck" CHECK ("industrial_safety"."pipeline_runs"."status" in ('registered','loading','validated','published','failed','superseded')),
	CONSTRAINT "pipeline_runs_scope_ck" CHECK ("industrial_safety"."pipeline_runs"."publication_scope" ~ '^industrial_safety[.][a-z0-9_.-]+$'),
	CONSTRAINT "pipeline_runs_primary_sha_ck" CHECK ("industrial_safety"."pipeline_runs"."primary_artifact_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pipeline_runs_fingerprint_ck" CHECK ("industrial_safety"."pipeline_runs"."run_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pipeline_runs_row_count_ck" CHECK ("industrial_safety"."pipeline_runs"."expected_row_count" >= 0 and ("industrial_safety"."pipeline_runs"."loaded_row_count" is null or "industrial_safety"."pipeline_runs"."loaded_row_count" >= 0)),
	CONSTRAINT "pipeline_runs_validated_count_ck" CHECK ("industrial_safety"."pipeline_runs"."status" not in ('validated','published') or ("industrial_safety"."pipeline_runs"."loaded_row_count" is not null and "industrial_safety"."pipeline_runs"."loaded_row_count" = "industrial_safety"."pipeline_runs"."expected_row_count")),
	CONSTRAINT "pipeline_runs_current_ck" CHECK (not "industrial_safety"."pipeline_runs"."is_current" or "industrial_safety"."pipeline_runs"."status" = 'published')
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."workplace_allocation_cells" (
	"allocation_cell_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."workplace_allocation_cells_allocation_cell_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"prediction_origin_week_start" date NOT NULL,
	"prediction_as_of" timestamp with time zone NOT NULL,
	"target_week_start" date NOT NULL,
	"target_week_end" date NOT NULL,
	"population_snapshot_month" date NOT NULL,
	"population_available_from" timestamp with time zone,
	"population_availability_basis" text NOT NULL,
	"population_reconstructed" boolean NOT NULL,
	"population_source_snapshot_date" date,
	"population_snapshot_age_days" integer,
	"population_snapshot_age_days_at_target_week_start" integer,
	"population_snapshot_age_basis" text,
	"population_2025_annual_register_used" boolean DEFAULT false NOT NULL,
	"sido" text NOT NULL,
	"industry_big" text NOT NULL,
	"represented_workplace_count" bigint NOT NULL,
	"cell_total_expected_approved_record_count" double precision NOT NULL,
	"coverage_observed_raw_workers" bigint NOT NULL,
	"coverage_official_workers" bigint NOT NULL,
	"coverage_q_raw_worker_share" double precision NOT NULL,
	"coverage_q_equal_unit_risk" double precision NOT NULL,
	"coverage_q_was_capped" boolean NOT NULL,
	"unallocated_expected_approved_record_count_q" double precision GENERATED ALWAYS AS ("cell_total_expected_approved_record_count" * (1 - "coverage_q_equal_unit_risk")) STORED,
	"conservation_claim_scope" text NOT NULL,
	"prediction_regime" text NOT NULL,
	"cell_model_calibration_status" text NOT NULL,
	"label_vintage_replay_status" text NOT NULL,
	"size_rate_source_year" smallint,
	"coverage_source_year" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_allocation_cells_natural_uq" UNIQUE("run_id","target_week_start","sido","industry_big"),
	CONSTRAINT "workplace_allocation_cells_fact_fk_uq" UNIQUE("allocation_cell_id","run_id","target_week_start"),
	CONSTRAINT "workplace_allocation_cells_week_ck" CHECK (extract(isodow from "industrial_safety"."workplace_allocation_cells"."prediction_origin_week_start") = 1 and extract(isodow from "industrial_safety"."workplace_allocation_cells"."target_week_start") = 1 and "industrial_safety"."workplace_allocation_cells"."prediction_origin_week_start" = "industrial_safety"."workplace_allocation_cells"."target_week_start" - 7 and "industrial_safety"."workplace_allocation_cells"."target_week_end" = "industrial_safety"."workplace_allocation_cells"."target_week_start" + 6),
	CONSTRAINT "workplace_allocation_cells_counts_ck" CHECK ("industrial_safety"."workplace_allocation_cells"."represented_workplace_count" >= 0 and "industrial_safety"."workplace_allocation_cells"."coverage_observed_raw_workers" >= 0 and "industrial_safety"."workplace_allocation_cells"."coverage_official_workers" >= 0),
	CONSTRAINT "workplace_allocation_cells_values_ck" CHECK ("industrial_safety"."workplace_allocation_cells"."cell_total_expected_approved_record_count" >= 0 and "industrial_safety"."workplace_allocation_cells"."coverage_q_raw_worker_share" >= 0 and "industrial_safety"."workplace_allocation_cells"."coverage_q_equal_unit_risk" between 0 and 1 and "industrial_safety"."workplace_allocation_cells"."unallocated_expected_approved_record_count_q" >= 0),
	CONSTRAINT "workplace_allocation_cells_coverage_capped_ck" CHECK ("industrial_safety"."workplace_allocation_cells"."coverage_q_was_capped" = ("industrial_safety"."workplace_allocation_cells"."coverage_q_raw_worker_share" > 1) and "industrial_safety"."workplace_allocation_cells"."coverage_q_equal_unit_risk" = least("industrial_safety"."workplace_allocation_cells"."coverage_q_raw_worker_share", 1::double precision))
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."workplace_predictions" (
	"target_week_start" date NOT NULL,
	"run_id" bigint NOT NULL,
	"workplace_snapshot_id" bigint NOT NULL,
	"allocation_cell_id" bigint NOT NULL,
	"workers_imputed" boolean NOT NULL,
	"size_bucket_broad" text NOT NULL,
	"size_relative_risk" double precision NOT NULL,
	"allocation_weight_share" double precision NOT NULL,
	"allocated_expected_approved_record_count_q" double precision NOT NULL,
	"research_only_provisional_probability" double precision NOT NULL,
	"validated_probability_any_approved_accident_record" double precision,
	"provisional_population_priority_percentile" double precision NOT NULL,
	"provisional_population_priority_band" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_predictions_pk" PRIMARY KEY("target_week_start","run_id","workplace_snapshot_id"),
	CONSTRAINT "workplace_predictions_week_ck" CHECK (extract(isodow from "industrial_safety"."workplace_predictions"."target_week_start") = 1),
	CONSTRAINT "workplace_predictions_size_risk_ck" CHECK ("industrial_safety"."workplace_predictions"."size_relative_risk" >= 0),
	CONSTRAINT "workplace_predictions_weight_ck" CHECK ("industrial_safety"."workplace_predictions"."allocation_weight_share" between 0 and 1),
	CONSTRAINT "workplace_predictions_expected_ck" CHECK ("industrial_safety"."workplace_predictions"."allocated_expected_approved_record_count_q" >= 0),
	CONSTRAINT "workplace_predictions_provisional_probability_ck" CHECK ("industrial_safety"."workplace_predictions"."research_only_provisional_probability" between 0 and 1),
	CONSTRAINT "workplace_predictions_validated_probability_ck" CHECK ("industrial_safety"."workplace_predictions"."validated_probability_any_approved_accident_record" is null or "industrial_safety"."workplace_predictions"."validated_probability_any_approved_accident_record" between 0 and 1),
	CONSTRAINT "workplace_predictions_priority_ck" CHECK ("industrial_safety"."workplace_predictions"."provisional_population_priority_percentile" between 0 and 1 and "industrial_safety"."workplace_predictions"."provisional_population_priority_band" in ('상위1%','상위5%','상위10%','일반'))
) PARTITION BY RANGE ("target_week_start");
--> statement-breakpoint
CREATE TABLE "industrial_safety"."workplace_snapshots" (
	"workplace_snapshot_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."workplace_snapshots_workplace_snapshot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workplace_pk" bigint NOT NULL,
	"source_run_id" bigint NOT NULL,
	"snapshot_month" date NOT NULL,
	"snapshot_version" smallint DEFAULT 1 NOT NULL,
	"population_source_snapshot_date" date,
	"source_entity_link_id" text NOT NULL,
	"workplace_name" text,
	"address" text,
	"road_address" text,
	"lot_address" text,
	"postal_code" text,
	"business_registration_masked" text,
	"business_registration_prefix6" text,
	"sido" text NOT NULL,
	"sigungu" text,
	"industry_code" text NOT NULL,
	"industry_name" text,
	"industry_big" text NOT NULL,
	"workers" bigint NOT NULL,
	"workplace_type" text,
	"entity_key_strength" text NOT NULL,
	"population_definition_version" text NOT NULL,
	"management_number_available" boolean DEFAULT false NOT NULL,
	"source_record_count" smallint,
	"source_duplicate_entity" boolean DEFAULT false NOT NULL,
	"source_workers_conflict" boolean DEFAULT false NOT NULL,
	"source_industry_value_conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_snapshots_version_uq" UNIQUE("workplace_pk","snapshot_month","snapshot_version"),
	CONSTRAINT "workplace_snapshots_run_workplace_month_uq" UNIQUE("source_run_id","workplace_pk","snapshot_month"),
	CONSTRAINT "workplace_snapshots_month_ck" CHECK (extract(day from "industrial_safety"."workplace_snapshots"."snapshot_month") = 1),
	CONSTRAINT "workplace_snapshots_version_ck" CHECK ("industrial_safety"."workplace_snapshots"."snapshot_version" >= 1),
	CONSTRAINT "workplace_snapshots_workers_ck" CHECK ("industrial_safety"."workplace_snapshots"."workers" >= 0),
	CONSTRAINT "workplace_snapshots_prefix6_ck" CHECK ("industrial_safety"."workplace_snapshots"."business_registration_prefix6" is null or "industrial_safety"."workplace_snapshots"."business_registration_prefix6" ~ '^[0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."workplaces" (
	"workplace_pk" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "industrial_safety"."workplaces_workplace_pk_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_system" text NOT NULL,
	"source_workplace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplaces_source_id_uq" UNIQUE("source_system","source_workplace_id"),
	CONSTRAINT "workplaces_source_system_ck" CHECK ("industrial_safety"."workplaces"."source_system" in ('nps','kcomwel')),
	CONSTRAINT "workplaces_source_id_format_ck" CHECK (("industrial_safety"."workplaces"."source_system" = 'nps' and "industrial_safety"."workplaces"."source_workplace_id" ~ '^npss_[0-9a-f]{20}$') or ("industrial_safety"."workplaces"."source_system" = 'kcomwel' and "industrial_safety"."workplaces"."source_workplace_id" ~ '^kwm_[0-9a-f]{24}$'))
);
--> statement-breakpoint
CREATE TABLE "industrial_safety"."workplace_predictions_2026q2"
	PARTITION OF "industrial_safety"."workplace_predictions"
	FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs"
	ADD CONSTRAINT "pipeline_runs_required_text_ck" CHECK (
		btrim("publication_scope") <> ''
		AND btrim("pipeline_name") <> ''
		AND btrim("pipeline_version") <> ''
		AND btrim("contract_version") <> ''
		AND btrim("primary_artifact_path") <> ''
	),
	ADD CONSTRAINT "pipeline_runs_artifact_bundle_ck"
		CHECK (jsonb_typeof("artifact_bundle") = 'array'),
	ADD CONSTRAINT "pipeline_runs_quality_metadata_ck"
		CHECK (jsonb_typeof("quality_metadata") = 'object'),
	ADD CONSTRAINT "pipeline_runs_published_ck"
		CHECK ("status" <> 'published' OR "published_at" IS NOT NULL),
	ADD CONSTRAINT "pipeline_runs_target_range_ck" CHECK (
		("target_week_start_min" IS NULL AND "target_week_start_max" IS NULL)
		OR (
			"target_week_start_min" IS NOT NULL
			AND "target_week_start_max" IS NOT NULL
			AND "target_week_start_min" <= "target_week_start_max"
			AND extract(isodow FROM "target_week_start_min") = 1
			AND extract(isodow FROM "target_week_start_max") = 1
		)
	),
	ADD CONSTRAINT "pipeline_runs_prediction_metadata_ck" CHECK (
		"run_kind" NOT IN ('cell_prediction', 'workplace_prediction')
		OR ("model_name" IS NOT NULL AND "model_version" IS NOT NULL)
	),
	ADD CONSTRAINT "pipeline_runs_workplace_metadata_ck" CHECK (
		"run_kind" <> 'workplace_prediction'
		OR (
			"population_tier" IS NOT NULL
			AND "scenario_id" IS NOT NULL
			AND "calibration_status" IS NOT NULL
			AND "probability_status" IS NOT NULL
			AND "risk_value_type" IS NOT NULL
			AND "priority_reference_population" IS NOT NULL
		)
	);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_run_dependencies"
	ADD CONSTRAINT "pipeline_run_dependencies_metadata_ck"
		CHECK (jsonb_typeof("metadata") = 'object');
--> statement-breakpoint
ALTER TABLE "industrial_safety"."cell_label_datasets"
	ADD CONSTRAINT "cell_label_datasets_loaded_ck"
		CHECK ("loaded_row_count" IS NULL OR "loaded_row_count" = "expected_row_count"),
	ADD CONSTRAINT "cell_label_datasets_complete_week_ck"
		CHECK ("complete_through_week_start" IS NULL OR extract(isodow FROM "complete_through_week_start") = 1),
	ADD CONSTRAINT "cell_label_datasets_metadata_ck"
		CHECK (jsonb_typeof("metadata") = 'object');
--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_snapshots"
	ADD CONSTRAINT "workplace_snapshots_source_record_count_ck"
		CHECK ("source_record_count" IS NULL OR "source_record_count" >= 1);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."cell_week_predictions"
	ADD CONSTRAINT "cell_week_predictions_asof_ck"
		CHECK ("data_as_of" < ("week_start"::timestamp AT TIME ZONE 'Asia/Seoul')),
	ADD CONSTRAINT "cell_week_predictions_snapshot_month_ck"
		CHECK (extract(day FROM "snapshot_month") = 1),
	ADD CONSTRAINT "cell_week_predictions_expected_ck" CHECK (
		"cell_total_expected_approved_record_count" >= 0
		AND ("challenger_expected_approved_record_count" IS NULL OR "challenger_expected_approved_record_count" >= 0)
		AND ("baseline_oof_expected_approved_record_count" IS NULL OR "baseline_oof_expected_approved_record_count" >= 0)
		AND ("challenger_oof_expected_approved_record_count" IS NULL OR "challenger_oof_expected_approved_record_count" >= 0)
	),
	ADD CONSTRAINT "cell_week_predictions_alpha_ck" CHECK (
		"cell_nb_alpha" >= 0
		AND ("challenger_nb_alpha" IS NULL OR "challenger_nb_alpha" >= 0)
	);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_allocation_cells"
	ADD CONSTRAINT "workplace_allocation_cells_asof_ck"
		CHECK ("prediction_as_of" < ("target_week_start"::timestamp AT TIME ZONE 'Asia/Seoul')),
	ADD CONSTRAINT "workplace_allocation_cells_snapshot_month_ck"
		CHECK (extract(day FROM "population_snapshot_month") = 1);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_links"
	ADD CONSTRAINT "firm_links_json_ck" CHECK (
		jsonb_typeof("source_key_snapshot") = 'object'
		AND jsonb_typeof("target_key_snapshot") = 'object'
		AND jsonb_typeof("evidence") = 'object'
	),
	ADD CONSTRAINT "firm_links_accepted_target_ck" CHECK (
		"decision_status" NOT IN ('auto_accepted', 'human_accepted')
		OR ("firm_id" IS NOT NULL AND "candidate_state" = 'matched_candidate')
	),
	ADD CONSTRAINT "firm_links_unmatched_ck"
		CHECK ("candidate_state" <> 'unmatched' OR "firm_id" IS NULL),
	ADD CONSTRAINT "firm_links_review_ck" CHECK (
		(
			"decision_status" NOT IN ('human_accepted', 'human_rejected')
			OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
		)
		AND ("reviewed_at" IS NULL OR "reviewed_by" IS NOT NULL)
	);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."cell_label_datasets" ADD CONSTRAINT "cell_label_datasets_source_run_fk" FOREIGN KEY ("source_run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."cell_week_labels" ADD CONSTRAINT "cell_week_labels_dataset_fk" FOREIGN KEY ("label_dataset_id") REFERENCES "industrial_safety"."cell_label_datasets"("label_dataset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."cell_week_predictions" ADD CONSTRAINT "cell_week_predictions_run_fk" FOREIGN KEY ("run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_links" ADD CONSTRAINT "firm_links_run_fk" FOREIGN KEY ("link_run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_links" ADD CONSTRAINT "firm_links_snapshot_fk" FOREIGN KEY ("workplace_snapshot_id") REFERENCES "industrial_safety"."workplace_snapshots"("workplace_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_links" ADD CONSTRAINT "firm_links_firm_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_run_dependencies" ADD CONSTRAINT "pipeline_run_dependencies_run_fk" FOREIGN KEY ("run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_run_dependencies" ADD CONSTRAINT "pipeline_run_dependencies_upstream_fk" FOREIGN KEY ("upstream_run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_allocation_cells" ADD CONSTRAINT "workplace_allocation_cells_run_fk" FOREIGN KEY ("run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_predictions" ADD CONSTRAINT "workplace_predictions_run_fk" FOREIGN KEY ("run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_predictions" ADD CONSTRAINT "workplace_predictions_snapshot_fk" FOREIGN KEY ("workplace_snapshot_id") REFERENCES "industrial_safety"."workplace_snapshots"("workplace_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_predictions" ADD CONSTRAINT "workplace_predictions_allocation_cell_fk" FOREIGN KEY ("allocation_cell_id","run_id","target_week_start") REFERENCES "industrial_safety"."workplace_allocation_cells"("allocation_cell_id","run_id","target_week_start") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_snapshots" ADD CONSTRAINT "workplace_snapshots_workplace_fk" FOREIGN KEY ("workplace_pk") REFERENCES "industrial_safety"."workplaces"("workplace_pk") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."workplace_snapshots" ADD CONSTRAINT "workplace_snapshots_source_run_fk" FOREIGN KEY ("source_run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cell_week_labels_week_idx" ON "industrial_safety"."cell_week_labels" USING btree ("week_start","label_dataset_id");--> statement-breakpoint
CREATE INDEX "cell_week_predictions_week_idx" ON "industrial_safety"."cell_week_predictions" USING btree ("week_start","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_links_one_accepted_uq" ON "industrial_safety"."firm_links" USING btree ("link_run_id","workplace_snapshot_id") WHERE "industrial_safety"."firm_links"."decision_status" in ('auto_accepted','human_accepted');--> statement-breakpoint
CREATE INDEX "firm_links_firm_current_idx" ON "industrial_safety"."firm_links" USING btree ("firm_id","link_run_id") WHERE "industrial_safety"."firm_links"."decision_status" in ('auto_accepted','human_accepted');--> statement-breakpoint
CREATE INDEX "pipeline_run_dependencies_upstream_idx" ON "industrial_safety"."pipeline_run_dependencies" USING btree ("upstream_run_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_current_scope_uq" ON "industrial_safety"."pipeline_runs" USING btree ("publication_scope") WHERE "industrial_safety"."pipeline_runs"."is_current";--> statement-breakpoint
CREATE INDEX "pipeline_runs_artifact_sha_idx" ON "industrial_safety"."pipeline_runs" USING btree ("primary_artifact_sha256");--> statement-breakpoint
CREATE INDEX "workplace_allocation_cells_run_week_idx" ON "industrial_safety"."workplace_allocation_cells" USING btree ("run_id","target_week_start");--> statement-breakpoint
CREATE INDEX "workplace_predictions_snapshot_history_idx" ON "industrial_safety"."workplace_predictions" USING btree ("workplace_snapshot_id","target_week_start" DESC NULLS LAST,"run_id");--> statement-breakpoint
CREATE INDEX "workplace_predictions_run_priority_idx" ON "industrial_safety"."workplace_predictions" USING btree ("run_id","target_week_start","provisional_population_priority_percentile" DESC NULLS LAST,"workplace_snapshot_id");--> statement-breakpoint
CREATE INDEX "workplace_predictions_run_band_idx" ON "industrial_safety"."workplace_predictions" USING btree ("run_id","target_week_start","provisional_population_priority_band");--> statement-breakpoint
CREATE INDEX "workplace_snapshots_workplace_month_idx" ON "industrial_safety"."workplace_snapshots" USING btree ("workplace_pk","snapshot_month");--> statement-breakpoint
CREATE INDEX "workplace_snapshots_name_biz_idx" ON "industrial_safety"."workplace_snapshots" USING btree ("workplace_name","business_registration_prefix6") WHERE "industrial_safety"."workplace_snapshots"."workplace_name" is not null and "industrial_safety"."workplace_snapshots"."business_registration_prefix6" is not null;--> statement-breakpoint
CREATE INDEX "workplace_snapshots_region_industry_idx" ON "industrial_safety"."workplace_snapshots" USING btree ("snapshot_month" DESC NULLS LAST,"sido","industry_big");--> statement-breakpoint
CREATE INDEX "workplace_snapshots_entity_link_idx" ON "industrial_safety"."workplace_snapshots" USING btree ("source_entity_link_id");
--> statement-breakpoint
CREATE VIEW "industrial_safety"."v_current_workplace_risk_internal"
WITH (security_barrier = true)
AS
SELECT
	p.run_id,
	r.pipeline_name,
	r.pipeline_version,
	r.model_name,
	r.model_version,
	r.population_tier,
	r.scenario_id,
	r.calibration_status,
	r.probability_status,
	r.risk_value_type,
	r.priority_reference_population,
	w.source_system,
	w.source_workplace_id,
	s.workplace_snapshot_id,
	s.snapshot_month,
	s.workplace_name,
	s.address,
	s.business_registration_masked,
	s.sido,
	s.sigungu,
	s.industry_code,
	s.industry_name,
	s.industry_big,
	s.workers,
	p.target_week_start,
	c.target_week_end,
	c.prediction_as_of,
	p.workers_imputed,
	p.size_bucket_broad,
	p.size_relative_risk,
	p.allocation_weight_share,
	p.allocated_expected_approved_record_count_q,
	p.research_only_provisional_probability,
	p.validated_probability_any_approved_accident_record,
	p.provisional_population_priority_percentile,
	p.provisional_population_priority_band
FROM "industrial_safety"."workplace_predictions" AS p
JOIN "industrial_safety"."pipeline_runs" AS r
  ON r.run_id = p.run_id
 AND r.run_kind = 'workplace_prediction'
 AND r.status = 'published'
 AND r.is_current
JOIN "industrial_safety"."workplace_allocation_cells" AS c
  ON c.allocation_cell_id = p.allocation_cell_id
 AND c.run_id = p.run_id
 AND c.target_week_start = p.target_week_start
JOIN "industrial_safety"."workplace_snapshots" AS s
  ON s.workplace_snapshot_id = p.workplace_snapshot_id
JOIN "industrial_safety"."workplaces" AS w
  ON w.workplace_pk = s.workplace_pk;
--> statement-breakpoint
CREATE VIEW "industrial_safety"."v_firm_accident_risk"
WITH (security_barrier = true)
AS
SELECT
	f.firm_id,
	f.name AS firm_name,
	r.population_tier,
	r.model_name,
	r.model_version,
	r.scenario_id,
	p.target_week_start,
	p.research_only_provisional_probability,
	p.validated_probability_any_approved_accident_record,
	p.provisional_population_priority_percentile,
	p.provisional_population_priority_band,
	r.calibration_status,
	r.probability_status,
	r.risk_value_type,
	l.match_method,
	l.confidence_tier,
	l.decision_status
FROM "industrial_safety"."workplace_predictions" AS p
JOIN "industrial_safety"."pipeline_runs" AS r
  ON r.run_id = p.run_id
 AND r.run_kind = 'workplace_prediction'
 AND r.status = 'published'
 AND r.is_current
JOIN "industrial_safety"."firm_links" AS l
  ON l.workplace_snapshot_id = p.workplace_snapshot_id
 AND l.decision_status IN ('auto_accepted', 'human_accepted')
JOIN "industrial_safety"."pipeline_runs" AS link_run
  ON link_run.run_id = l.link_run_id
 AND link_run.run_kind = 'firm_link'
 AND link_run.status = 'published'
 AND link_run.is_current
JOIN "public"."firms" AS f
  ON f.firm_id = l.firm_id;
--> statement-breakpoint
CREATE VIEW "industrial_safety"."v_cell_api_label_comparison"
WITH (security_barrier = true)
AS
WITH current_cell_predictions AS (
	SELECT p.*
	FROM "industrial_safety"."cell_week_predictions" AS p
	JOIN "industrial_safety"."pipeline_runs" AS r
	  ON r.run_id = p.run_id
	 AND r.run_kind = 'cell_prediction'
	 AND r.publication_scope = 'industrial_safety.cell_prediction.main'
	 AND r.status = 'published'
	 AND r.is_current
),
current_v2_labels AS (
	SELECT l.*
	FROM "industrial_safety"."cell_week_labels" AS l
	JOIN "industrial_safety"."cell_label_datasets" AS d
	  ON d.label_dataset_id = l.label_dataset_id
	 AND d.dataset_code = 'v2_occurrence_bounded_sequence_reset'
	JOIN "industrial_safety"."pipeline_runs" AS r
	  ON r.run_id = d.source_run_id
	 AND r.publication_scope = 'industrial_safety.cell_prediction.main'
	 AND r.status = 'published'
	 AND r.is_current
),
current_api_labels AS (
	SELECT l.*
	FROM "industrial_safety"."cell_week_labels" AS l
	JOIN "industrial_safety"."cell_label_datasets" AS d
	  ON d.label_dataset_id = l.label_dataset_id
	 AND d.dataset_code = 'api_occurrence_bounded_exact_date'
	JOIN "industrial_safety"."pipeline_runs" AS r
	  ON r.run_id = d.source_run_id
	 AND r.publication_scope = 'industrial_safety.cell_label.api_occurrence_bounded_exact_date'
	 AND r.status = 'published'
	 AND r.is_current
)
SELECT
	p.run_id AS cell_prediction_run_id,
	p.week_start,
	p.week_end,
	p.sido,
	p.industry_big,
	p.cell_total_expected_approved_record_count,
	p.working_cell_probability_at_least_one_approval_record,
	p.prediction_regime,
	v.label_available AS v2_label_available,
	v.first_care_approval_record_count AS v2_bounded_first_care_approval_record_count,
	a.label_available AS api_label_available,
	a.first_care_approval_record_count AS api_exact_date_bounded_first_care_approval_record_count,
	CASE
		WHEN coalesce(v.label_available, false) AND coalesce(a.label_available, false)
			THEN 'both_observed'
		WHEN NOT coalesce(v.label_available, false) AND coalesce(a.label_available, false)
			THEN 'api_only_observed'
		WHEN coalesce(v.label_available, false) AND NOT coalesce(a.label_available, false)
			THEN 'v2_only_observed'
		ELSE 'neither_observed'
	END AS comparison_status,
	CASE
		WHEN coalesce(v.label_available, false) AND coalesce(a.label_available, false)
			THEN a.first_care_approval_record_count - v.first_care_approval_record_count
	END AS api_minus_v2_first_care_approval_record_count,
	false::boolean AS api_cell_count_is_workplace_label,
	false::boolean AS api_validates_workplace_probability
FROM current_cell_predictions AS p
LEFT JOIN current_v2_labels AS v
  ON v.week_start = p.week_start
 AND v.sido = p.sido
 AND v.industry_big = p.industry_big
LEFT JOIN current_api_labels AS a
  ON a.week_start = p.week_start
 AND a.sido = p.sido
 AND a.industry_big = p.industry_big;
--> statement-breakpoint
COMMENT ON SCHEMA "industrial_safety" IS
	'산업재해 주간 셀 예측과 사업장 배분 연구결과. 기존 임금체불 public 테이블과 분리한다.';
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."pipeline_runs" IS
	'모델·라벨·사업장·매칭 산출물의 불변 실행 및 적재 lineage. run_fingerprint로 멱등성을 보장한다.';
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."pipeline_run_dependencies" IS
	'산출물 run의 복수 입력 lineage. workplace prediction은 최소 cell_prediction과 population_snapshot 의존성을 공표 전 검증한다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."pipeline_runs"."population_tier" IS
	'모집단 구성 버전/해석 단위. NPS와 KCOMWEL은 대체 모집단이며 서로 합산하거나 같은 사업장 집합으로 간주하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplaces"."source_workplace_id" IS
	'모집단 tier 내부 대체키. 공식 영속 사업장 ID가 아니며 source_system 밖에서 단독 조인하지 않는다.';
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."cell_label_datasets" IS
	'발생주·승인주와 승인연도 추론이 다른 라벨을 별도 계약으로 등록한다. dataset 간 count를 무구분 덮어쓰기 하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_snapshots"."source_entity_link_id" IS
	'월간 동일사업장 후보 연결키. NPS 실측 중복이 있으므로 UNIQUE 또는 확정 영속키로 사용하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_snapshots"."business_registration_prefix6" IS
	'공개 마스킹 번호의 앞 6자리. 비고유이며 단독 사업장 식별·FK·자동승인에 사용하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."cell_week_predictions"."working_cell_probability_at_least_one_approval_record" IS
	'지역×업종 셀의 Poisson/NB 작업근사. 사업장 확률, 검증확률 또는 캘리브레이션 결과가 아니다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."cell_week_labels"."first_care_approval_record_count" IS
	'최초요양 승인 레코드 수. 고유 사고사건 수나 피해 사업장 수가 아니다. label_available=false이면 NULL이다.';
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."workplace_allocation_cells" IS
	'사업장 fact에서 분리한 주×시도×대업종 배분 문맥. represented_workplace_count가 0인 빈 셀은 현재 사업장 산출물에 합성하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_allocation_cells"."unallocated_expected_approved_record_count_q" IS
	'coverage_q_equal_unit_risk로 사업장에 배분되지 않은 셀 기대 승인레코드 수. DB 생성컬럼이며 source 입력값이 아니다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_predictions"."research_only_provisional_probability" IS
	'셀 기대 승인레코드 배분 시나리오를 1-exp(-m)로 변환한 연구용 잠정값. 검증된 산재 발생확률이 아니다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_predictions"."validated_probability_any_approved_accident_record" IS
	'exact 사업장×주 라벨로 외부검증된 경우에만 채운다. 현재 NPS/KCOMWEL 전 행 NULL이며 0으로 치환하지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."workplace_predictions"."provisional_population_priority_percentile" IS
	'같은 run·주·모집단 안의 잠정 점검 우선순위. 유사사업장 상대위험이나 인과효과가 아니다.';
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."firm_links" IS
	'산재 사업장 snapshot과 기존 public.firms의 후보·승인 이력. prefix6 단독 또는 fuzzy 자동승인을 금지한다.';
--> statement-breakpoint
COMMENT ON VIEW "industrial_safety"."v_current_workplace_risk_internal" IS
	'내부 검증용 현재 사업장 결과. 주소·마스킹 식별정보를 포함하므로 wg_bot에 공개하지 않는다.';
--> statement-breakpoint
COMMENT ON VIEW "industrial_safety"."v_firm_accident_risk" IS
	'현재 산업재해 결과 중 검증된 firm 링크만 제공한다. NPS/KCOMWEL tier는 대체 모집단이며 합산·평균하지 않는다.';
--> statement-breakpoint
COMMENT ON VIEW "industrial_safety"."v_cell_api_label_comparison" IS
	'v2 sequence-reset 라벨과 API exact-date bounded 라벨의 셀 비교. API count는 사업장 라벨이나 사업장 확률 검증값이 아니다.';
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "industrial_safety" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "industrial_safety" FROM PUBLIC;
