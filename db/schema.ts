/**
 * 돈워리 DB 스키마 — 실 서비스 번들(_service_bundle) 기준.
 *
 * 구성:
 *  - `firms`               사업장 마스터. 배치와 무관하게 한 사업장 = 한 행.
 *                          커뮤니티 글·리뷰가 이걸 참조한다.
 *  - `batches`             월 적재 단위 (as_of_date + model_version).
 *  - `scored_active`       전체 활성 사업장 점수 + 39피처 (552,500)
 *  - `inspector_queue`     감독관 위험큐 top3000 + SHAP 위험사유 (3,000)
 *  - `safe_recommendation` 구직자 안전추천 판정 (501,843)
 *  - `users/posts/comments/reviews`  사용자 생성 데이터
 *
 * ⚠️ 반드시 지킬 것 (AGENT_GUIDE / DB_BUILD_PROMPT)
 *  1. `biz_no`·`sido_code`·`industry_category` 는 **TEXT**. 정수로 읽으면 앞자리 0 소실·
 *     마스킹 깨짐. 특히 sido_code 는 모델이 문자열('11')로 학습해서 타입이 어긋나면 성능이 붕괴한다.
 *  2. `사업자번호는 비고유` — 29,887개 번호가 501,843행에 재사용된다(번호당 평균 약 17곳).
 *     번호 단독 키 금지. 식별은 `firm_id = sha1(사업장명||'|'||사업자번호)[:16]` — **원본 이름 그대로**.
 *     ⚠️ DB_BUILD_PROMPT §4 는 이름을 정규화(㈜/주식회사 제거)해 해싱하라고 하지만,
 *        그렇게 하면 서로 다른 **사업장**이 합쳐진다. 실측 결과 충돌 171건 중 168건이
 *        시도·피처가 다른 별개 사업장이었다(예: 한국쉘석유(주) 서울 vs 한국쉘석유주식회사 부산).
 *        국민연금은 법인이 아니라 사업장 단위라 정규화가 실데이터를 지운다.
 *        정규화 키는 `corp_key` 로 따로 두어 "같은 법인의 여러 사업장" 묶기에만 쓴다.
 *  3. `firm_id` 는 **불변이 아니다.** 사업장명이 바뀌면 달라진다(월 약 0.24%).
 *     그래서 `firms` 에 원본 `name`·`biz_no` 를 보존해 나중에 재매핑할 수 있게 둔다.
 *     ML 팀이 안정 firm_id 를 export 에 넣으면 그걸로 교체한다.
 *  4. `risk_full` 은 약 50,657곳(9.2%)에서 **NULL**(이력 부족으로 채점 불가). 0으로 채우지 말 것.
 *  5. `risk_full` 은 절대확률이 아니다 — 1:1 다운샘플링 학습이라 순위·분위로만 해석한다.
 *     보정값이 준비되면 `risk_calibrated` 에 채운다(현재 미사용).
 *  6. SHAP 위험사유는 `inspector_queue`(top3000)에만 있다. 나머지엔 없다 — 지어내지 말 것.
 */
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ── 사업장 마스터 ───────────────────────────────────────── */

export const firms = pgTable(
  "firms",
  {
    /** sha1(사업장명||'|'||사업자번호)[:16] — 원본 이름 기준. 잠정 키, 불변 아님 */
    firmId: text("firm_id").primaryKey(),
    /**
     * sha1(정규화(사업장명)||'|'||사업자번호)[:16].
     * 표기 변형(㈜↔주식회사)을 흡수해 **같은 법인의 여러 사업장을 묶는 용도**.
     * 식별키가 아니다 — 서로 다른 사업장이 같은 corp_key 를 가질 수 있다.
     */
    corpKey: text("corp_key"),
    /** 원본 표기 그대로 보존 (재매핑용) */
    name: text().notNull(),
    /** 마스킹 6자리. 비고유 — 단독으로 키가 될 수 없다 */
    bizNo: text("biz_no").notNull(),
    sido: text(),
    industry: text(),
    firstSeen: date("first_seen", { mode: "string" }),
    lastSeen: date("last_seen", { mode: "string" }),
  },
  (t) => [
    index("firms_name_idx").on(t.name),
    index("firms_biz_no_idx").on(t.bizNo),
    index("firms_corp_key_idx").on(t.corpKey),
    index("firms_sido_idx").on(t.sido),
  ],
);

/* ── 적재 배치 ───────────────────────────────────────────── */

export const batches = pgTable(
  "batches",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /**
     * 데이터 기준월 = 관측창의 끝 = t-6. 마지막으로 본 국민연금 데이터의 달.
     * 예: 2026-04 (관측창 2025-04 ~ 2026-04, 13개월)
     */
    asOfDate: date("as_of_date", { mode: "string" }),
    /**
     * 예측 대상월 = t = as_of_date + 6개월. "이때 명단공개될 위험" 을 뜻한다.
     * 예: 2026-10
     *
     * 두 날짜를 함께 두는 이유: 화면에 "2026년 4월 데이터 기준 · 2026년 10월 위험도" 로
     * 써야 사용자가 "지금 상태" 로 오해하지 않는다. 하나만 있으면 반드시 오해가 생긴다.
     */
    targetMonth: date("target_month", { mode: "string" }),
    /** 재학습·롤백 대비 버전 태그 (예: 260807) */
    modelVersion: text("model_version").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    source: text(),
    nScored: integer("n_scored").notNull().default(0),
    nQueue: integer("n_queue").notNull().default(0),
    nSafe: integer("n_safe").notNull().default(0),
  },
  (t) => [unique("batches_asof_model_uq").on(t.asOfDate, t.modelVersion)],
);

/* ── 전체 활성 사업장 점수 + 39피처 ──────────────────────── */

export const scoredActive = pgTable(
  "scored_active",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.firmId, { onDelete: "cascade" }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),

    nMonths: smallint("n_months"),
    /** 그린플래그 G1~G6 */
    g1EmploymentStable: boolean("g1_고용안정"),
    g2PaymentFaithful: boolean("g2_성실납부"),
    g3PayrollStable: boolean("g3_인건비안정"),
    g4WorkforceKept: boolean("g4_인력유지"),
    g5Age3y: boolean("g5_업력3년"),
    g6LowVolatility: boolean("g6_낮은변동성"),
    nGreen: smallint("n_green"),

    exclWage: boolean("체불배제"),
    exclTax: boolean("체납배제"),

    /** 0~1 위험점수. 약 9.2% 는 NULL(채점 불가) — 0으로 채우지 말 것 */
    riskFull: real("risk_full"),
    /** 캘리브레이션 결과를 넣을 자리. 준비되기 전까지 NULL */
    riskCalibrated: real("risk_calibrated"),

    // ── 예측 피처 39개 ──
    turnoverAvg12m: real("turnover_avg_12m"),
    turnoverAvg3m: real("turnover_avg_3m"),
    turnoverMax12m: real("turnover_max_12m"),
    turnoverStd12m: real("turnover_std_12m"),
    empChange3m: real("emp_change_3m"),
    empChange6m: real("emp_change_6m"),
    empChange12m: real("emp_change_12m"),
    salaryAvg12m: real("salary_avg_12m"),
    salaryLast: real("salary_last"),
    salaryChange6m: real("salary_change_6m"),
    salaryChange12m: real("salary_change_12m"),
    replacementAvg12m: real("replacement_avg_12m"),
    replacementAvg3m: real("replacement_avg_3m"),
    replacementMin12m: real("replacement_min_12m"),
    salaryDropConsecutive: real("salary_drop_consecutive"),
    turnoverMomentum: real("turnover_momentum"),
    zeroEmpMonths: real("zero_emp_months"),
    empVolatility: real("emp_volatility"),
    logEmpCount: real("log_emp_count"),
    firmAgeMonths: real("firm_age_months"),
    /** ⚠️ TEXT — 모델이 문자열로 학습했다 */
    sidoCode: text("sido_code"),
    /** ⚠️ TEXT */
    industryCategory: text("industry_category"),
    imputedMonthsCount: real("imputed_months_count"),
    imputedRatio: real("imputed_ratio"),
    hasMissingRecent3m: real("has_missing_recent_3m"),
    nfBillLastRatio: real("nf_bill_last_ratio"),
    nfBillMaxdrop: real("nf_bill_maxdrop"),
    nfPcSlope: real("nf_pc_slope"),
    nfPayDivergence: real("nf_pay_divergence"),
    nfBillCv: real("nf_bill_cv"),
    nfEmpSlope: real("nf_emp_slope"),
    nfDrawdown: real("nf_drawdown"),
    door1Ever: real("door1_ever"),
    door1NInsu: real("door1_n_insu"),
    door1Maxamt: real("door1_maxamt"),
    door1Maxmonths: real("door1_maxmonths"),
    door1Health: real("door1_health"),
    door1Pension: real("door1_pension"),
    door1Labor: real("door1_labor"),
  },
  (t) => [
    primaryKey({ columns: [t.firmId, t.batchId] }),
    index("scored_batch_risk_idx").on(t.batchId, t.riskFull),
    index("scored_batch_idx").on(t.batchId),
  ],
);

/* ── 감독관 위험큐 (top 3000) ────────────────────────────── */

export const inspectorQueue = pgTable(
  "inspector_queue",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.firmId, { onDelete: "cascade" }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    /** risk_full 내림차순 1~3000 */
    rank: integer().notNull(),
    /** 긴급(<100) / 우선(<500) / 주의(<1500) / 관찰 */
    grade: text().notNull(),
    riskFull: real("risk_full"),
    /** door1_체납이력 */
    door1Arrears: boolean("door1_체납이력"),
    /** 이미_임금체불공개 (= safe_recommendation 의 체불배제와 동일 플래그) */
    alreadyDisclosed: boolean("이미_임금체불공개"),
    /** SHAP 상위 3피처 한글명. top3000 에만 존재한다 */
    reasons: text().array(),
  },
  (t) => [
    primaryKey({ columns: [t.firmId, t.batchId] }),
    index("queue_batch_rank_idx").on(t.batchId, t.rank),
    index("queue_batch_grade_idx").on(t.batchId, t.grade),
  ],
);

/* ── 구직자 안전추천 ─────────────────────────────────────── */

export const safeRecommendation = pgTable(
  "safe_recommendation",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.firmId, { onDelete: "cascade" }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    nMonths: smallint("n_months"),
    nGreen: smallint("n_green"),
    riskFull: real("risk_full"),
    exclWage: boolean("체불배제"),
    exclTax: boolean("체납배제"),
    door1Ever: real("door1_ever"),
    /**
     * 안정신호 / 유보 / 유보_정보부족 /
     * 배제_4대보험체납(door1) / 배제_공개체납 / 배제_임금체불공개
     * — 문자열 그대로 보존한다.
     */
    verdict: text("판정").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.firmId, t.batchId] }),
    index("safe_batch_verdict_idx").on(t.batchId, t.verdict),
    index("safe_batch_risk_idx").on(t.batchId, t.riskFull),
  ],
);

/* ── 사용자 생성 데이터 ──────────────────────────────────── */

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  name: text().notNull(),
  /** 감독관 / 사업주 / 구직자 */
  role: text().notNull(),
  /** 사업주만 — 본인 사업장 */
  firmId: text("firm_id").references(() => firms.firmId, { onDelete: "set null" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * 익명 글이어도 작성자를 저장한다 — 본인 삭제·신고 처리에 필요.
     * 익명성은 조회 계층에서 이름을 빼는 것으로 지킨다.
     */
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    anonymous: boolean().notNull().default(true),
    title: text().notNull(),
    body: text().notNull(),
    firmId: text("firm_id").references(() => firms.firmId, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("posts_created_idx").on(t.createdAt), index("posts_firm_idx").on(t.firmId)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    anonymous: boolean().notNull().default(true),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_post_idx").on(t.postId, t.createdAt)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid().primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firmId: text("firm_id")
      .notNull()
      .references(() => firms.firmId, { onDelete: "cascade" }),
    anonymous: boolean().notNull().default(true),
    /** 현직 / 전직 */
    status: text().notNull(),
    ratingPay: smallint("rating_pay").notNull(),
    ratingWorklife: smallint("rating_worklife").notNull(),
    ratingCulture: smallint("rating_culture").notNull(),
    ratingManagement: smallint("rating_management").notNull(),
    pros: text().notNull(),
    cons: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reviews_firm_author_uq").on(t.firmId, t.authorId),
    index("reviews_firm_created_idx").on(t.firmId, t.createdAt),
  ],
);

/* ── 산업재해 ML 산출물 (별도 schema) ─────────────────────
 *
 * 주의:
 *  - PostgreSQL partition, security-barrier VIEW, COMMENT, GRANT는 Drizzle이
 *    완전히 표현하지 못하므로 0004_industrial_safety migration이 보강한다.
 *  - `drizzle-kit push`를 사용하지 말고 검토된 migration만 적용한다.
 *  - NPS와 KCOMWEL은 대체 모집단이며 합산하지 않는다.
 */

export const industrialSafety = pgSchema("industrial_safety");

export const industrialSafetyPipelineRuns = industrialSafety.table(
  "pipeline_runs",
  {
    runId: bigint("run_id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runKind: text("run_kind").notNull(),
    publicationScope: text("publication_scope").notNull(),
    pipelineName: text("pipeline_name").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    modelName: text("model_name"),
    modelVersion: text("model_version"),
    populationTier: text("population_tier"),
    scenarioId: text("scenario_id"),
    targetDefinition: text("target_definition"),
    approvalYearInference: text("approval_year_inference"),
    labelMaturityWindow: text("label_maturity_window"),
    calibrationStatus: text("calibration_status"),
    probabilityStatus: text("probability_status"),
    riskValueType: text("risk_value_type"),
    priorityReferencePopulation: text("priority_reference_population"),
    targetWeekStartMin: date("target_week_start_min", { mode: "string" }),
    targetWeekStartMax: date("target_week_start_max", { mode: "string" }),
    primaryArtifactPath: text("primary_artifact_path").notNull(),
    primaryArtifactSha256: text("primary_artifact_sha256").notNull(),
    artifactBundle: jsonb("artifact_bundle")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    runFingerprint: text("run_fingerprint").notNull(),
    expectedRowCount: bigint("expected_row_count", { mode: "number" }).notNull(),
    loadedRowCount: bigint("loaded_row_count", { mode: "number" }),
    status: text("status").notNull().default("registered"),
    isCurrent: boolean("is_current").notNull().default(false),
    qualityMetadata: jsonb("quality_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceGeneratedAt: timestamp("source_generated_at", {
      withTimezone: true,
      mode: "string",
    }),
    registeredAt: timestamp("registered_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    validatedAt: timestamp("validated_at", { withTimezone: true, mode: "string" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    unique("pipeline_runs_fingerprint_uq").on(t.runFingerprint),
    uniqueIndex("pipeline_runs_current_scope_uq")
      .on(t.publicationScope)
      .where(sql`${t.isCurrent}`),
    index("pipeline_runs_artifact_sha_idx").on(t.primaryArtifactSha256),
    check(
      "pipeline_runs_kind_ck",
      sql`${t.runKind} in ('cell_prediction','cell_label','workplace_prediction','workplace_snapshot','firm_link','firm_risk')`,
    ),
    check(
      "pipeline_runs_status_ck",
      sql`${t.status} in ('registered','loading','validated','published','failed','superseded')`,
    ),
    check(
      "pipeline_runs_scope_ck",
      sql`${t.publicationScope} ~ '^industrial_safety[.][a-z0-9_.-]+$'`,
    ),
    check(
      "pipeline_runs_primary_sha_ck",
      sql`${t.primaryArtifactSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "pipeline_runs_fingerprint_ck",
      sql`${t.runFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "pipeline_runs_row_count_ck",
      sql`${t.expectedRowCount} >= 0 and (${t.loadedRowCount} is null or ${t.loadedRowCount} >= 0)`,
    ),
    check(
      "pipeline_runs_validated_count_ck",
      sql`${t.status} not in ('validated','published') or (${t.loadedRowCount} is not null and ${t.loadedRowCount} = ${t.expectedRowCount})`,
    ),
    check(
      "pipeline_runs_current_ck",
      sql`not ${t.isCurrent} or ${t.status} = 'published'`,
    ),
    check(
      "pipeline_runs_required_text_ck",
      sql`btrim(${t.publicationScope}) <> '' and btrim(${t.pipelineName}) <> '' and btrim(${t.pipelineVersion}) <> '' and btrim(${t.contractVersion}) <> '' and btrim(${t.primaryArtifactPath}) <> ''`,
    ),
    check(
      "pipeline_runs_artifact_bundle_ck",
      sql`jsonb_typeof(${t.artifactBundle}) = 'array'`,
    ),
    check(
      "pipeline_runs_quality_metadata_ck",
      sql`jsonb_typeof(${t.qualityMetadata}) = 'object'`,
    ),
    check(
      "pipeline_runs_published_ck",
      sql`${t.status} <> 'published' or ${t.publishedAt} is not null`,
    ),
    check(
      "pipeline_runs_target_range_ck",
      sql`(${t.targetWeekStartMin} is null and ${t.targetWeekStartMax} is null) or (${t.targetWeekStartMin} is not null and ${t.targetWeekStartMax} is not null and ${t.targetWeekStartMin} <= ${t.targetWeekStartMax} and extract(isodow from ${t.targetWeekStartMin}) = 1 and extract(isodow from ${t.targetWeekStartMax}) = 1)`,
    ),
    check(
      "pipeline_runs_prediction_metadata_ck",
      sql`${t.runKind} not in ('cell_prediction','workplace_prediction','firm_risk') or (${t.modelName} is not null and ${t.modelVersion} is not null)`,
    ),
    check(
      "pipeline_runs_workplace_metadata_ck",
      sql`${t.runKind} <> 'workplace_prediction' or (${t.populationTier} is not null and ${t.scenarioId} is not null and ${t.calibrationStatus} is not null and ${t.probabilityStatus} is not null and ${t.riskValueType} is not null and ${t.priorityReferencePopulation} is not null)`,
    ),
    check(
      "pipeline_runs_firm_risk_metadata_ck",
      sql`${t.runKind} <> 'firm_risk' or (${t.populationTier} is not null and ${t.scenarioId} is not null and ${t.calibrationStatus} is not null and ${t.probabilityStatus} is not null and ${t.riskValueType} is not null and ${t.priorityReferencePopulation} is not null)`,
    ),
    check(
      "pipeline_runs_firm_risk_single_week_ck",
      sql`${t.runKind} <> 'firm_risk' or (${t.targetWeekStartMin} is not null and ${t.targetWeekStartMax} is not null and ${t.targetWeekStartMax} = ${t.targetWeekStartMin})`,
    ),
  ],
);

export const industrialSafetyPipelineRunDependencies = industrialSafety.table(
  "pipeline_run_dependencies",
  {
    runId: bigint("run_id", { mode: "number" }).notNull(),
    dependencyRole: text("dependency_role").notNull(),
    upstreamRunId: bigint("upstream_run_id", { mode: "number" }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "pipeline_run_dependencies_pk",
      columns: [t.runId, t.dependencyRole, t.upstreamRunId],
    }),
    foreignKey({
      name: "pipeline_run_dependencies_run_fk",
      columns: [t.runId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("cascade"),
    foreignKey({
      name: "pipeline_run_dependencies_upstream_fk",
      columns: [t.upstreamRunId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    index("pipeline_run_dependencies_upstream_idx").on(t.upstreamRunId, t.runId),
    check("pipeline_run_dependencies_not_self_ck", sql`${t.runId} <> ${t.upstreamRunId}`),
    check(
      "pipeline_run_dependencies_role_ck",
      sql`${t.dependencyRole} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      "pipeline_run_dependencies_metadata_ck",
      sql`jsonb_typeof(${t.metadata}) = 'object'`,
    ),
  ],
);

export const industrialSafetyCellLabelDatasets = industrialSafety.table(
  "cell_label_datasets",
  {
    labelDatasetId: bigint("label_dataset_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sourceRunId: bigint("source_run_id", { mode: "number" }).notNull(),
    datasetCode: text("dataset_code").notNull(),
    sourceSystem: text("source_system").notNull(),
    timeBasis: text("time_basis").notNull(),
    targetDefinition: text("target_definition").notNull(),
    approvalYearInference: text("approval_year_inference").notNull(),
    labelMaturityWindow: text("label_maturity_window"),
    recordUnit: text("record_unit").notNull(),
    completeThroughWeekStart: date("complete_through_week_start", { mode: "string" }),
    workplaceIdentifierAvailable: boolean("workplace_identifier_available").notNull(),
    isUniqueAccidentEventCount: boolean("is_unique_accident_event_count").notNull(),
    validatedWorkplaceProbabilityAvailable: boolean(
      "validated_workplace_probability_available",
    ).notNull(),
    artifactPath: text("artifact_path").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    expectedRowCount: bigint("expected_row_count", { mode: "number" }).notNull(),
    loadedRowCount: bigint("loaded_row_count", { mode: "number" }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "cell_label_datasets_source_run_fk",
      columns: [t.sourceRunId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    unique("cell_label_datasets_run_code_uq").on(t.sourceRunId, t.datasetCode),
    check("cell_label_datasets_time_basis_ck", sql`${t.timeBasis} in ('occurrence_week','approval_week')`),
    check("cell_label_datasets_sha_ck", sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "cell_label_datasets_rows_ck",
      sql`${t.expectedRowCount} >= 0 and (${t.loadedRowCount} is null or ${t.loadedRowCount} >= 0)`,
    ),
    check(
      "cell_label_datasets_loaded_ck",
      sql`${t.loadedRowCount} is null or ${t.loadedRowCount} = ${t.expectedRowCount}`,
    ),
    check(
      "cell_label_datasets_complete_week_ck",
      sql`${t.completeThroughWeekStart} is null or extract(isodow from ${t.completeThroughWeekStart}) = 1`,
    ),
    check(
      "cell_label_datasets_metadata_ck",
      sql`jsonb_typeof(${t.metadata}) = 'object'`,
    ),
  ],
);

export const industrialSafetyWorkplaces = industrialSafety.table(
  "workplaces",
  {
    workplacePk: bigint("workplace_pk", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sourceSystem: text("source_system").notNull(),
    sourceWorkplaceId: text("source_workplace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workplaces_source_id_uq").on(t.sourceSystem, t.sourceWorkplaceId),
    check("workplaces_source_system_ck", sql`${t.sourceSystem} in ('nps','kcomwel')`),
    check(
      "workplaces_source_id_format_ck",
      sql`(${t.sourceSystem} = 'nps' and ${t.sourceWorkplaceId} ~ '^npss_[0-9a-f]{20}$') or (${t.sourceSystem} = 'kcomwel' and ${t.sourceWorkplaceId} ~ '^kwm_[0-9a-f]{24}$')`,
    ),
  ],
);

export const industrialSafetyWorkplaceSnapshots = industrialSafety.table(
  "workplace_snapshots",
  {
    workplaceSnapshotId: bigint("workplace_snapshot_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    workplacePk: bigint("workplace_pk", { mode: "number" }).notNull(),
    sourceRunId: bigint("source_run_id", { mode: "number" }).notNull(),
    snapshotMonth: date("snapshot_month", { mode: "string" }).notNull(),
    snapshotVersion: smallint("snapshot_version").notNull().default(1),
    populationSourceSnapshotDate: date("population_source_snapshot_date", { mode: "string" }),
    sourceEntityLinkId: text("source_entity_link_id").notNull(),
    workplaceName: text("workplace_name"),
    address: text("address"),
    roadAddress: text("road_address"),
    lotAddress: text("lot_address"),
    postalCode: text("postal_code"),
    businessRegistrationMasked: text("business_registration_masked"),
    businessRegistrationPrefix6: text("business_registration_prefix6"),
    sido: text("sido").notNull(),
    sigungu: text("sigungu"),
    industryCode: text("industry_code").notNull(),
    industryName: text("industry_name"),
    industryBig: text("industry_big").notNull(),
    workers: bigint("workers", { mode: "number" }).notNull(),
    workplaceType: text("workplace_type"),
    entityKeyStrength: text("entity_key_strength").notNull(),
    populationDefinitionVersion: text("population_definition_version").notNull(),
    managementNumberAvailable: boolean("management_number_available").notNull().default(false),
    sourceRecordCount: smallint("source_record_count"),
    sourceDuplicateEntity: boolean("source_duplicate_entity").notNull().default(false),
    sourceWorkersConflict: boolean("source_workers_conflict").notNull().default(false),
    sourceIndustryValueConflict: boolean("source_industry_value_conflict")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "workplace_snapshots_workplace_fk",
      columns: [t.workplacePk],
      foreignColumns: [industrialSafetyWorkplaces.workplacePk],
    }).onDelete("restrict"),
    foreignKey({
      name: "workplace_snapshots_source_run_fk",
      columns: [t.sourceRunId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    unique("workplace_snapshots_version_uq").on(
      t.workplacePk,
      t.snapshotMonth,
      t.snapshotVersion,
    ),
    unique("workplace_snapshots_run_workplace_month_uq").on(
      t.sourceRunId,
      t.workplacePk,
      t.snapshotMonth,
    ),
    index("workplace_snapshots_workplace_month_idx").on(t.workplacePk, t.snapshotMonth),
    index("workplace_snapshots_name_biz_idx")
      .on(t.workplaceName, t.businessRegistrationPrefix6)
      .where(sql`${t.workplaceName} is not null and ${t.businessRegistrationPrefix6} is not null`),
    index("workplace_snapshots_region_industry_idx").on(
      t.snapshotMonth.desc(),
      t.sido,
      t.industryBig,
    ),
    index("workplace_snapshots_entity_link_idx").on(t.sourceEntityLinkId),
    check("workplace_snapshots_month_ck", sql`extract(day from ${t.snapshotMonth}) = 1`),
    check("workplace_snapshots_version_ck", sql`${t.snapshotVersion} >= 1`),
    check("workplace_snapshots_workers_ck", sql`${t.workers} >= 0`),
    check(
      "workplace_snapshots_prefix6_ck",
      sql`${t.businessRegistrationPrefix6} is null or ${t.businessRegistrationPrefix6} ~ '^[0-9]{6}$'`,
    ),
    check(
      "workplace_snapshots_source_record_count_ck",
      sql`${t.sourceRecordCount} is null or ${t.sourceRecordCount} >= 1`,
    ),
  ],
);

export const industrialSafetyCellWeekPredictions = industrialSafety.table(
  "cell_week_predictions",
  {
    runId: bigint("run_id", { mode: "number" }).notNull(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    weekEnd: date("week_end", { mode: "string" }).notNull(),
    dataAsOf: timestamp("data_as_of", { withTimezone: true, mode: "string" }).notNull(),
    snapshotMonth: date("snapshot_month", { mode: "string" }).notNull(),
    availableFrom: timestamp("available_from", { withTimezone: true, mode: "string" }),
    availabilityBasis: text("availability_basis").notNull(),
    populationReconstructed: boolean("population_reconstructed").notNull(),
    snapshotAgeDays: integer("snapshot_age_days").notNull(),
    sido: text("sido").notNull(),
    industryBig: text("industry_big").notNull(),
    workplaceCount: bigint("workplace_count", { mode: "number" }).notNull(),
    workers: doublePrecision("workers").notNull(),
    exposureWorkers: doublePrecision("exposure_workers").notNull(),
    populationCellMissing: boolean("population_cell_missing").notNull(),
    cellTotalExpectedApprovedRecordCount: doublePrecision(
      "cell_total_expected_approved_record_count",
    ).notNull(),
    challengerExpectedApprovedRecordCount: doublePrecision(
      "challenger_expected_approved_record_count",
    ),
    challengerNbAlpha: doublePrecision("challenger_nb_alpha"),
    challengerModelVersion: text("challenger_model_version"),
    baselineOofExpectedApprovedRecordCount: doublePrecision(
      "baseline_oof_expected_approved_record_count",
    ),
    challengerOofExpectedApprovedRecordCount: doublePrecision(
      "challenger_oof_expected_approved_record_count",
    ),
    workingCellProbabilityAtLeastOneApprovalRecord: doublePrecision(
      "working_cell_probability_at_least_one_approval_record",
    ).notNull(),
    cellCountP05: bigint("cell_count_p05", { mode: "number" }).notNull(),
    cellCountP95: bigint("cell_count_p95", { mode: "number" }).notNull(),
    cellCountDistribution: text("cell_count_distribution").notNull(),
    cellNbAlpha: doublePrecision("cell_nb_alpha").notNull(),
    predictionRegime: text("prediction_regime").notNull(),
    cellModelCalibrationStatus: text("cell_model_calibration_status").notNull(),
    labelVintageReplayStatus: text("label_vintage_replay_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "cell_week_predictions_run_fk",
      columns: [t.runId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    primaryKey({
      name: "cell_week_predictions_pk",
      columns: [t.runId, t.weekStart, t.sido, t.industryBig],
    }),
    index("cell_week_predictions_week_idx").on(t.weekStart, t.runId),
    check(
      "cell_week_predictions_week_ck",
      sql`extract(isodow from ${t.weekStart}) = 1 and ${t.weekEnd} = ${t.weekStart} + 6`,
    ),
    check(
      "cell_week_predictions_population_ck",
      sql`${t.workplaceCount} >= 0 and ${t.workers} >= 0 and ${t.exposureWorkers} >= 0`,
    ),
    check(
      "cell_week_predictions_probability_ck",
      sql`${t.workingCellProbabilityAtLeastOneApprovalRecord} between 0 and 1`,
    ),
    check(
      "cell_week_predictions_interval_ck",
      sql`${t.cellCountP05} >= 0 and ${t.cellCountP95} >= ${t.cellCountP05}`,
    ),
    check(
      "cell_week_predictions_asof_ck",
      sql`${t.dataAsOf} < (${t.weekStart}::timestamp at time zone 'Asia/Seoul')`,
    ),
    check(
      "cell_week_predictions_snapshot_month_ck",
      sql`extract(day from ${t.snapshotMonth}) = 1`,
    ),
    check(
      "cell_week_predictions_expected_ck",
      sql`${t.cellTotalExpectedApprovedRecordCount} >= 0 and (${t.challengerExpectedApprovedRecordCount} is null or ${t.challengerExpectedApprovedRecordCount} >= 0) and (${t.baselineOofExpectedApprovedRecordCount} is null or ${t.baselineOofExpectedApprovedRecordCount} >= 0) and (${t.challengerOofExpectedApprovedRecordCount} is null or ${t.challengerOofExpectedApprovedRecordCount} >= 0)`,
    ),
    check(
      "cell_week_predictions_alpha_ck",
      sql`${t.cellNbAlpha} >= 0 and (${t.challengerNbAlpha} is null or ${t.challengerNbAlpha} >= 0)`,
    ),
  ],
);

export const industrialSafetyCellWeekLabels = industrialSafety.table(
  "cell_week_labels",
  {
    labelDatasetId: bigint("label_dataset_id", { mode: "number" }).notNull(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    sido: text("sido").notNull(),
    industryBig: text("industry_big").notNull(),
    labelAvailable: boolean("label_available").notNull(),
    firstCareApprovalRecordCount: bigint("first_care_approval_record_count", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "cell_week_labels_dataset_fk",
      columns: [t.labelDatasetId],
      foreignColumns: [industrialSafetyCellLabelDatasets.labelDatasetId],
    }).onDelete("restrict"),
    primaryKey({
      name: "cell_week_labels_pk",
      columns: [t.labelDatasetId, t.weekStart, t.sido, t.industryBig],
    }),
    index("cell_week_labels_week_idx").on(t.weekStart, t.labelDatasetId),
    check("cell_week_labels_week_ck", sql`extract(isodow from ${t.weekStart}) = 1`),
    check(
      "cell_week_labels_availability_ck",
      sql`(${t.labelAvailable} and ${t.firstCareApprovalRecordCount} is not null and ${t.firstCareApprovalRecordCount} >= 0) or (not ${t.labelAvailable} and ${t.firstCareApprovalRecordCount} is null)`,
    ),
  ],
);

export const industrialSafetyWorkplaceAllocationCells = industrialSafety.table(
  "workplace_allocation_cells",
  {
    allocationCellId: bigint("allocation_cell_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    predictionOriginWeekStart: date("prediction_origin_week_start", {
      mode: "string",
    }).notNull(),
    predictionAsOf: timestamp("prediction_as_of", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    targetWeekStart: date("target_week_start", { mode: "string" }).notNull(),
    targetWeekEnd: date("target_week_end", { mode: "string" }).notNull(),
    populationSnapshotMonth: date("population_snapshot_month", { mode: "string" }).notNull(),
    populationAvailableFrom: timestamp("population_available_from", {
      withTimezone: true,
      mode: "string",
    }),
    populationAvailabilityBasis: text("population_availability_basis").notNull(),
    populationReconstructed: boolean("population_reconstructed").notNull(),
    populationSourceSnapshotDate: date("population_source_snapshot_date", { mode: "string" }),
    populationSnapshotAgeDays: integer("population_snapshot_age_days"),
    populationSnapshotAgeDaysAtTargetWeekStart: integer(
      "population_snapshot_age_days_at_target_week_start",
    ),
    populationSnapshotAgeBasis: text("population_snapshot_age_basis"),
    population2025AnnualRegisterUsed: boolean("population_2025_annual_register_used")
      .notNull()
      .default(false),
    sido: text("sido").notNull(),
    industryBig: text("industry_big").notNull(),
    representedWorkplaceCount: bigint("represented_workplace_count", { mode: "number" })
      .notNull(),
    cellTotalExpectedApprovedRecordCount: doublePrecision(
      "cell_total_expected_approved_record_count",
    ).notNull(),
    coverageObservedRawWorkers: bigint("coverage_observed_raw_workers", { mode: "number" })
      .notNull(),
    coverageOfficialWorkers: bigint("coverage_official_workers", { mode: "number" }).notNull(),
    coverageQRawWorkerShare: doublePrecision("coverage_q_raw_worker_share").notNull(),
    coverageQEqualUnitRisk: doublePrecision("coverage_q_equal_unit_risk").notNull(),
    coverageQWasCapped: boolean("coverage_q_was_capped").notNull(),
    unallocatedExpectedApprovedRecordCountQ: doublePrecision(
      "unallocated_expected_approved_record_count_q",
    ).generatedAlwaysAs(
      sql`"cell_total_expected_approved_record_count" * (1 - "coverage_q_equal_unit_risk")`,
    ),
    conservationClaimScope: text("conservation_claim_scope").notNull(),
    predictionRegime: text("prediction_regime").notNull(),
    cellModelCalibrationStatus: text("cell_model_calibration_status").notNull(),
    labelVintageReplayStatus: text("label_vintage_replay_status").notNull(),
    sizeRateSourceYear: smallint("size_rate_source_year"),
    coverageSourceYear: smallint("coverage_source_year"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "workplace_allocation_cells_run_fk",
      columns: [t.runId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    unique("workplace_allocation_cells_natural_uq").on(
      t.runId,
      t.targetWeekStart,
      t.sido,
      t.industryBig,
    ),
    unique("workplace_allocation_cells_fact_fk_uq").on(
      t.allocationCellId,
      t.runId,
      t.targetWeekStart,
    ),
    index("workplace_allocation_cells_run_week_idx").on(t.runId, t.targetWeekStart),
    check(
      "workplace_allocation_cells_week_ck",
      sql`extract(isodow from ${t.predictionOriginWeekStart}) = 1 and extract(isodow from ${t.targetWeekStart}) = 1 and ${t.predictionOriginWeekStart} = ${t.targetWeekStart} - 7 and ${t.targetWeekEnd} = ${t.targetWeekStart} + 6`,
    ),
    check(
      "workplace_allocation_cells_counts_ck",
      sql`${t.representedWorkplaceCount} >= 0 and ${t.coverageObservedRawWorkers} >= 0 and ${t.coverageOfficialWorkers} >= 0`,
    ),
    check(
      "workplace_allocation_cells_values_ck",
      sql`${t.cellTotalExpectedApprovedRecordCount} >= 0 and ${t.coverageQRawWorkerShare} >= 0 and ${t.coverageQEqualUnitRisk} between 0 and 1 and ${t.unallocatedExpectedApprovedRecordCountQ} >= 0`,
    ),
    check(
      "workplace_allocation_cells_coverage_capped_ck",
      sql`${t.coverageQWasCapped} = (${t.coverageQRawWorkerShare} > 1) and ${t.coverageQEqualUnitRisk} = least(${t.coverageQRawWorkerShare}, 1::double precision)`,
    ),
    check(
      "workplace_allocation_cells_asof_ck",
      sql`${t.predictionAsOf} < (${t.targetWeekStart}::timestamp at time zone 'Asia/Seoul')`,
    ),
    check(
      "workplace_allocation_cells_snapshot_month_ck",
      sql`extract(day from ${t.populationSnapshotMonth}) = 1`,
    ),
  ],
);

/**
 * 실제 migration은 이 parent를 `PARTITION BY RANGE (target_week_start)`로 만들고
 * 검토된 분기 child만 수동 생성한다. Drizzle에는 partition 모델링 API가 없다.
 */
export const industrialSafetyWorkplacePredictions = industrialSafety.table(
  "workplace_predictions",
  {
    targetWeekStart: date("target_week_start", { mode: "string" }).notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    workplaceSnapshotId: bigint("workplace_snapshot_id", { mode: "number" }).notNull(),
    allocationCellId: bigint("allocation_cell_id", { mode: "number" }).notNull(),
    workersImputed: boolean("workers_imputed").notNull(),
    sizeBucketBroad: text("size_bucket_broad").notNull(),
    sizeRelativeRisk: doublePrecision("size_relative_risk").notNull(),
    allocationWeightShare: doublePrecision("allocation_weight_share").notNull(),
    allocatedExpectedApprovedRecordCountQ: doublePrecision(
      "allocated_expected_approved_record_count_q",
    ).notNull(),
    researchOnlyProvisionalProbability: doublePrecision(
      "research_only_provisional_probability",
    ).notNull(),
    validatedProbabilityAnyApprovedAccidentRecord: doublePrecision(
      "validated_probability_any_approved_accident_record",
    ),
    provisionalPopulationPriorityPercentile: doublePrecision(
      "provisional_population_priority_percentile",
    ).notNull(),
    provisionalPopulationPriorityBand: text("provisional_population_priority_band").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "workplace_predictions_run_fk",
      columns: [t.runId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "workplace_predictions_snapshot_fk",
      columns: [t.workplaceSnapshotId],
      foreignColumns: [industrialSafetyWorkplaceSnapshots.workplaceSnapshotId],
    }).onDelete("restrict"),
    primaryKey({
      name: "workplace_predictions_pk",
      columns: [t.targetWeekStart, t.runId, t.workplaceSnapshotId],
    }),
    foreignKey({
      name: "workplace_predictions_allocation_cell_fk",
      columns: [t.allocationCellId, t.runId, t.targetWeekStart],
      foreignColumns: [
        industrialSafetyWorkplaceAllocationCells.allocationCellId,
        industrialSafetyWorkplaceAllocationCells.runId,
        industrialSafetyWorkplaceAllocationCells.targetWeekStart,
      ],
    }).onDelete("restrict"),
    index("workplace_predictions_snapshot_history_idx").on(
      t.workplaceSnapshotId,
      t.targetWeekStart.desc(),
      t.runId,
    ),
    index("workplace_predictions_run_priority_idx").on(
      t.runId,
      t.targetWeekStart,
      t.provisionalPopulationPriorityPercentile.desc(),
      t.workplaceSnapshotId,
    ),
    index("workplace_predictions_run_band_idx").on(
      t.runId,
      t.targetWeekStart,
      t.provisionalPopulationPriorityBand,
    ),
    check(
      "workplace_predictions_week_ck",
      sql`extract(isodow from ${t.targetWeekStart}) = 1`,
    ),
    check("workplace_predictions_size_risk_ck", sql`${t.sizeRelativeRisk} >= 0`),
    check(
      "workplace_predictions_weight_ck",
      sql`${t.allocationWeightShare} between 0 and 1`,
    ),
    check(
      "workplace_predictions_expected_ck",
      sql`${t.allocatedExpectedApprovedRecordCountQ} >= 0`,
    ),
    check(
      "workplace_predictions_provisional_probability_ck",
      sql`${t.researchOnlyProvisionalProbability} between 0 and 1`,
    ),
    check(
      "workplace_predictions_validated_probability_ck",
      sql`${t.validatedProbabilityAnyApprovedAccidentRecord} is null or ${t.validatedProbabilityAnyApprovedAccidentRecord} between 0 and 1`,
    ),
    check(
      "workplace_predictions_priority_ck",
      sql`${t.provisionalPopulationPriorityPercentile} between 0 and 1 and ${t.provisionalPopulationPriorityBand} in ('상위1%','상위5%','상위10%','일반')`,
    ),
  ],
);

/**
 * 기존 `public.firms`와 검증된 연결이 있는 산업재해 결과만 보존한다.
 * ambiguous/unmatched 후보는 이 fact에 넣지 않고 제한된 검토 보고서로 관리한다.
 */
export const industrialSafetyFirmRiskResults = industrialSafety.table(
  "firm_risk_results",
  {
    runId: bigint("run_id", { mode: "number" }).notNull(),
    firmId: text("firm_id").notNull(),
    targetWeekStart: date("target_week_start", { mode: "string" }).notNull(),
    predictionAsOf: timestamp("prediction_as_of", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    /** 내부 provenance 전용이며 LLM 안전 VIEW에는 노출하지 않는다. */
    sourceWorkplaceId: text("source_workplace_id").notNull(),
    /** firm entity 연결 검증 상태이며 모델·확률 검증 상태가 아니다. */
    validationStatus: text("validation_status").notNull(),
    matchMethod: text("match_method").notNull(),
    confidenceTier: text("confidence_tier").notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    provisionalPopulationPriorityPercentile: doublePrecision(
      "provisional_population_priority_percentile",
    ).notNull(),
    provisionalPopulationPriorityBand: text(
      "provisional_population_priority_band",
    ).notNull(),
    /** 내부 재현용 연구값이며 검증된 사업장 사고확률이 아니다. */
    researchOnlyProvisionalProbability: doublePrecision(
      "research_only_provisional_probability",
    ).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "firm_risk_results_pk",
      columns: [t.runId, t.firmId, t.targetWeekStart],
    }),
    foreignKey({
      name: "firm_risk_results_run_fk",
      columns: [t.runId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "firm_risk_results_firm_fk",
      columns: [t.firmId],
      foreignColumns: [firms.firmId],
    }).onDelete("restrict"),
    unique("firm_risk_results_source_uq").on(
      t.runId,
      t.sourceWorkplaceId,
      t.targetWeekStart,
    ),
    index("firm_risk_results_firm_history_idx").on(
      t.firmId,
      t.targetWeekStart.desc(),
      t.runId,
    ),
    check(
      "firm_risk_results_week_ck",
      sql`extract(isodow from ${t.targetWeekStart}) = 1`,
    ),
    check(
      "firm_risk_results_asof_ck",
      sql`${t.predictionAsOf} < (${t.targetWeekStart}::timestamp at time zone 'Asia/Seoul')`,
    ),
    check(
      "firm_risk_results_source_id_ck",
      sql`${t.sourceWorkplaceId} ~ '^npss_[0-9a-f]{20}$'`,
    ),
    check(
      "firm_risk_results_probability_ck",
      sql`${t.researchOnlyProvisionalProbability} between 0 and 1`,
    ),
    check(
      "firm_risk_results_priority_ck",
      sql`${t.provisionalPopulationPriorityPercentile} between 0 and 1 and ${t.provisionalPopulationPriorityBand} in ('상위1%','상위5%','상위10%','일반')`,
    ),
    check(
      "firm_risk_results_review_pair_ck",
      sql`(${t.reviewedBy} is null) = (${t.reviewedAt} is null)`,
    ),
    check(
      "firm_risk_results_validation_ck",
      sql`(${t.validationStatus} = 'verified_exact' and ${t.matchMethod} = 'exact_name_masked_business_registration_sido_industry' and ${t.confidenceTier} = 'exact_unique') or (${t.validationStatus} = 'verified_human' and ${t.matchMethod} = 'human_review' and ${t.confidenceTier} = 'human_approved' and ${t.reviewedBy} is not null and ${t.reviewedAt} is not null)`,
    ),
  ],
);

export const industrialSafetyFirmLinks = industrialSafety.table(
  "firm_links",
  {
    firmLinkId: bigint("firm_link_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    linkRunId: bigint("link_run_id", { mode: "number" }).notNull(),
    workplaceSnapshotId: bigint("workplace_snapshot_id", { mode: "number" }).notNull(),
    candidateRank: smallint("candidate_rank").notNull(),
    firmId: text("firm_id"),
    candidateState: text("candidate_state").notNull(),
    decisionStatus: text("decision_status").notNull(),
    matchMethod: text("match_method").notNull(),
    confidenceTier: text("confidence_tier").notNull(),
    confidenceScore: doublePrecision("confidence_score"),
    sourceKeyUnique: boolean("source_key_unique").notNull().default(false),
    targetKeyUnique: boolean("target_key_unique").notNull().default(false),
    sourceKeySnapshot: jsonb("source_key_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    targetKeySnapshot: jsonb("target_key_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "firm_links_run_fk",
      columns: [t.linkRunId],
      foreignColumns: [industrialSafetyPipelineRuns.runId],
    }).onDelete("restrict"),
    foreignKey({
      name: "firm_links_snapshot_fk",
      columns: [t.workplaceSnapshotId],
      foreignColumns: [industrialSafetyWorkplaceSnapshots.workplaceSnapshotId],
    }).onDelete("restrict"),
    foreignKey({
      name: "firm_links_firm_fk",
      columns: [t.firmId],
      foreignColumns: [firms.firmId],
    }).onDelete("restrict"),
    unique("firm_links_rank_uq").on(t.linkRunId, t.workplaceSnapshotId, t.candidateRank),
    unique("firm_links_candidate_identity_uq")
      .on(t.linkRunId, t.workplaceSnapshotId, t.firmId)
      .nullsNotDistinct(),
    uniqueIndex("firm_links_one_accepted_uq")
      .on(t.linkRunId, t.workplaceSnapshotId)
      .where(sql`${t.decisionStatus} in ('auto_accepted','human_accepted')`),
    index("firm_links_firm_current_idx")
      .on(t.firmId, t.linkRunId)
      .where(sql`${t.decisionStatus} in ('auto_accepted','human_accepted')`),
    check(
      "firm_links_candidate_state_ck",
      sql`${t.candidateState} in ('matched_candidate','ambiguous_candidate','unmatched')`,
    ),
    check(
      "firm_links_decision_status_ck",
      sql`${t.decisionStatus} in ('auto_accepted','pending_review','human_accepted','human_rejected','not_applicable')`,
    ),
    check("firm_links_candidate_rank_ck", sql`${t.candidateRank} between 1 and 100`),
    check(
      "firm_links_confidence_score_ck",
      sql`${t.confidenceScore} is null or ${t.confidenceScore} between 0 and 1`,
    ),
    check(
      "firm_links_auto_accept_ck",
      sql`${t.decisionStatus} <> 'auto_accepted' or (${t.firmId} is not null and ${t.candidateState} = 'matched_candidate' and ${t.matchMethod} = 'exact_name_masked_business_registration' and ${t.sourceKeyUnique} and ${t.targetKeyUnique})`,
    ),
    check(
      "firm_links_json_ck",
      sql`jsonb_typeof(${t.sourceKeySnapshot}) = 'object' and jsonb_typeof(${t.targetKeySnapshot}) = 'object' and jsonb_typeof(${t.evidence}) = 'object'`,
    ),
    check(
      "firm_links_accepted_target_ck",
      sql`${t.decisionStatus} not in ('auto_accepted','human_accepted') or (${t.firmId} is not null and ${t.candidateState} = 'matched_candidate')`,
    ),
    check(
      "firm_links_unmatched_ck",
      sql`${t.candidateState} <> 'unmatched' or ${t.firmId} is null`,
    ),
    check(
      "firm_links_review_ck",
      sql`(${t.decisionStatus} not in ('human_accepted','human_rejected') or (${t.reviewedBy} is not null and ${t.reviewedAt} is not null)) and (${t.reviewedAt} is null or ${t.reviewedBy} is not null)`,
    ),
  ],
);
