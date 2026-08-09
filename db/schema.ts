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
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
     * 데이터 기준월 — 이 출력이 어느 국민연금 데이터로 만들어졌는지.
     * 확정 전에는 NULL. 화면에 "기준월"을 표시하려면 반드시 채워야 한다.
     */
    asOfDate: date("as_of_date", { mode: "string" }),
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
