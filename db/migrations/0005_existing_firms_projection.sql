CREATE TABLE "industrial_safety"."firm_risk_results" (
	"run_id" bigint NOT NULL,
	"firm_id" text NOT NULL,
	"target_week_start" date NOT NULL,
	"prediction_as_of" timestamp with time zone NOT NULL,
	"source_workplace_id" text NOT NULL,
	"validation_status" text NOT NULL,
	"match_method" text NOT NULL,
	"confidence_tier" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"provisional_population_priority_percentile" double precision NOT NULL,
	"provisional_population_priority_band" text NOT NULL,
	"research_only_provisional_probability" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_risk_results_pk" PRIMARY KEY("run_id","firm_id","target_week_start"),
	CONSTRAINT "firm_risk_results_source_uq" UNIQUE("run_id","source_workplace_id","target_week_start"),
	CONSTRAINT "firm_risk_results_week_ck" CHECK (extract(isodow from "industrial_safety"."firm_risk_results"."target_week_start") = 1),
	CONSTRAINT "firm_risk_results_asof_ck" CHECK ("industrial_safety"."firm_risk_results"."prediction_as_of" < ("industrial_safety"."firm_risk_results"."target_week_start"::timestamp at time zone 'Asia/Seoul')),
	CONSTRAINT "firm_risk_results_source_id_ck" CHECK ("industrial_safety"."firm_risk_results"."source_workplace_id" ~ '^npss_[0-9a-f]{20}$'),
	CONSTRAINT "firm_risk_results_probability_ck" CHECK ("industrial_safety"."firm_risk_results"."research_only_provisional_probability" between 0 and 1),
	CONSTRAINT "firm_risk_results_priority_ck" CHECK ("industrial_safety"."firm_risk_results"."provisional_population_priority_percentile" between 0 and 1 and "industrial_safety"."firm_risk_results"."provisional_population_priority_band" in ('상위1%','상위5%','상위10%','일반')),
	CONSTRAINT "firm_risk_results_review_pair_ck" CHECK (("industrial_safety"."firm_risk_results"."reviewed_by" is null) = ("industrial_safety"."firm_risk_results"."reviewed_at" is null)),
	CONSTRAINT "firm_risk_results_validation_ck" CHECK (("industrial_safety"."firm_risk_results"."validation_status" = 'verified_exact' and "industrial_safety"."firm_risk_results"."match_method" = 'exact_name_masked_business_registration_sido_industry' and "industrial_safety"."firm_risk_results"."confidence_tier" = 'exact_unique') or ("industrial_safety"."firm_risk_results"."validation_status" = 'verified_human' and "industrial_safety"."firm_risk_results"."match_method" = 'human_review' and "industrial_safety"."firm_risk_results"."confidence_tier" = 'human_approved' and "industrial_safety"."firm_risk_results"."reviewed_by" is not null and "industrial_safety"."firm_risk_results"."reviewed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" DROP CONSTRAINT "pipeline_runs_kind_ck";--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" DROP CONSTRAINT "pipeline_runs_prediction_metadata_ck";--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_risk_results" ADD CONSTRAINT "firm_risk_results_run_fk" FOREIGN KEY ("run_id") REFERENCES "industrial_safety"."pipeline_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industrial_safety"."firm_risk_results" ADD CONSTRAINT "firm_risk_results_firm_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_risk_results_firm_history_idx" ON "industrial_safety"."firm_risk_results" USING btree ("firm_id","target_week_start" DESC NULLS LAST,"run_id");--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_firm_risk_metadata_ck" CHECK ("industrial_safety"."pipeline_runs"."run_kind" <> 'firm_risk' or ("industrial_safety"."pipeline_runs"."population_tier" is not null and "industrial_safety"."pipeline_runs"."scenario_id" is not null and "industrial_safety"."pipeline_runs"."calibration_status" is not null and "industrial_safety"."pipeline_runs"."probability_status" is not null and "industrial_safety"."pipeline_runs"."risk_value_type" is not null and "industrial_safety"."pipeline_runs"."priority_reference_population" is not null));--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_firm_risk_single_week_ck" CHECK ("industrial_safety"."pipeline_runs"."run_kind" <> 'firm_risk' or ("industrial_safety"."pipeline_runs"."target_week_start_min" is not null and "industrial_safety"."pipeline_runs"."target_week_start_max" is not null and "industrial_safety"."pipeline_runs"."target_week_start_max" = "industrial_safety"."pipeline_runs"."target_week_start_min"));--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_kind_ck" CHECK ("industrial_safety"."pipeline_runs"."run_kind" in ('cell_prediction','cell_label','workplace_prediction','workplace_snapshot','firm_link','firm_risk'));--> statement-breakpoint
ALTER TABLE "industrial_safety"."pipeline_runs" ADD CONSTRAINT "pipeline_runs_prediction_metadata_ck" CHECK ("industrial_safety"."pipeline_runs"."run_kind" not in ('cell_prediction','workplace_prediction','firm_risk') or ("industrial_safety"."pipeline_runs"."model_name" is not null and "industrial_safety"."pipeline_runs"."model_version" is not null));
--> statement-breakpoint
CREATE VIEW "industrial_safety"."v_llm_firm_safety_context"
WITH (security_barrier = true)
AS
WITH clock AS (
	SELECT timezone('Asia/Seoul', statement_timestamp())::date AS today
)
SELECT
	f."firm_id",
	f."name" AS "firm_name",
	f."sido",
	f."industry",
	rr."run_id",
	rr."target_week_start",
	(rr."target_week_start" + 6) AS "target_week_end",
	rr."prediction_as_of",
	rr."validation_status" AS "firm_match_validation_status",
	rr."match_method",
	rr."confidence_tier",
	rr."provisional_population_priority_percentile",
	rr."provisional_population_priority_band",
	pr."population_tier",
	pr."model_name",
	pr."model_version",
	pr."calibration_status",
	pr."probability_status",
	pr."risk_value_type",
	pr."priority_reference_population",
	pr."source_generated_at",
	pr."validated_at",
	pr."published_at",
	pr."primary_artifact_sha256" AS "source_sha256",
	CASE
		WHEN clock.today < rr."target_week_start" THEN 'not_yet_effective'
		WHEN clock.today <= rr."target_week_start" + 6 THEN 'current_target_week'
		ELSE 'stale_target_week'
	END AS "temporal_status",
	false::boolean AS "is_validated_workplace_probability"
FROM "industrial_safety"."firm_risk_results" AS rr
JOIN "industrial_safety"."pipeline_runs" AS pr
  ON pr."run_id" = rr."run_id"
 AND pr."run_kind" = 'firm_risk'
 AND pr."publication_scope" = 'industrial_safety.firm_risk.existing_firms.nps'
 AND pr."status" = 'published'
 AND pr."is_current"
JOIN "public"."firms" AS f
  ON f."firm_id" = rr."firm_id"
CROSS JOIN clock;
--> statement-breakpoint
COMMENT ON TABLE "industrial_safety"."firm_risk_results" IS
	'기존 public.firms와 엄격하게 검증된 NPS 산업재해 우선순위 결과만 보존한다. ambiguous/unmatched 후보는 이 fact에 넣지 않는다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."firm_risk_results"."validation_status" IS
	'사업장 identity 연결 검증 상태이며 모델 또는 사고확률의 검증 상태가 아니다.';
--> statement-breakpoint
COMMENT ON COLUMN "industrial_safety"."firm_risk_results"."research_only_provisional_probability" IS
	'셀 기대 승인레코드 배분 시나리오를 1-exp(-m)로 변환한 연구용 잠정값. LLM 안전 뷰에 노출하지 않으며 검증된 사업장 사고확률이 아니다.';
--> statement-breakpoint
COMMENT ON VIEW "industrial_safety"."v_llm_firm_safety_context" IS
	'LLM 호출 전 검증용 최소 조회 계층. 엄격 연결·현재 published run만 노출하며 원천 ID, 사업자번호, 주소, 연구용 잠정확률은 숨긴다.';
--> statement-breakpoint
REVOKE ALL ON TABLE "industrial_safety"."firm_risk_results" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "industrial_safety"."v_llm_firm_safety_context" FROM PUBLIC;
