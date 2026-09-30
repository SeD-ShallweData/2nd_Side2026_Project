import { getNextBatchDueDate } from "@/adapters/real/MlRiskProvider";
import { LATEST_DRIFT_CHECK } from "@/config/driftCheckRecord";
import type {
  BatchDomainStatus,
  BatchGradeDistribution,
  BatchGradeShare,
  BatchStatus,
  BatchStatusListResponse,
} from "@/domain/batch";
import { cachedAggregate } from "@/server/aggregateCache";
import { LATEST_BATCH_ORDER_SQL } from "@/server/latestBatchSql";
import { queryReadOnly } from "@/server/postgres";
import { ServiceError } from "@/utils/errors";

/*
 * 배치 현황 = public.batches 이력 + 정의서(docs/mlops/MLOps_배치현황정의서.md) 항목.
 *
 * 읽는 계정은 wg_bot(읽기 전용)이다. 등급 분포는 wg_bot 기본 권한
 * (db/scripts/sql/configure-path-b-release-bot.sql)이 주는 관계만 쓴다:
 *   임금체불 — public.scored_active + public.safe_recommendation (서비스 배치 행)
 *   산업재해 — industrial_safety.v_llm_firm_safety_context
 * 55만·51만 행을 세므로 10분 캐시한다(임금은 서비스 배치 ID 가 키라 전환하면 다시 센다).
 * 어느 하나를 읽지 못해도 페이지는 뜨고 그 칸만 "⚪ 검사 불가"로 보인다.
 */

const DOMAIN_CACHE_TTL_MS = 10 * 60_000;

/** 정의서 작성 시점(2026-09-11) 기준값. aggregation-spec.md §1.1. */
export const REFERENCE_ROW_COUNTS = { wage: 553_598, safety: 515_608 } as const;

interface WageGradeRow {
  total: number;
  normal_count: number;
  watch_count: number;
  review_count: number;
  unknown_count: number;
}

interface SafetyGradeRow {
  total: number;
  top1_count: number;
  top5_count: number;
  top10_count: number;
  normal_count: number;
  prediction_as_of: string | null;
  target_week_start: string | null;
  target_week_end: string | null;
  stale_count: number;
}

/* migration 0012 v_region_industry_signal 과 같은 판정 매핑. 분모는 채점 대상 전체(판정 없음 포함). */
export const WAGE_GRADE_SQL = `WITH graded AS (
  SELECT CASE
           WHEN v."판정" = '안정신호' THEN 'normal'
           WHEN v."판정" = '유보' THEN 'watch'
           WHEN v."판정" LIKE '배제%' THEN 'review'
           ELSE 'unknown'
         END AS signal_level
    FROM public.scored_active AS s
    LEFT JOIN public.safe_recommendation AS v ON v.firm_id = s.firm_id AND v.batch_id = s.batch_id
   WHERE s.batch_id = $1
)
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE signal_level = 'normal')::int AS normal_count,
       count(*) FILTER (WHERE signal_level = 'watch')::int AS watch_count,
       count(*) FILTER (WHERE signal_level = 'review')::int AS review_count,
       count(*) FILTER (WHERE signal_level = 'unknown')::int AS unknown_count
  FROM graded`;

export const SAFETY_GRADE_SQL = `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE provisional_population_priority_band = '상위1%')::int AS top1_count,
       count(*) FILTER (WHERE provisional_population_priority_band = '상위5%')::int AS top5_count,
       count(*) FILTER (WHERE provisional_population_priority_band = '상위10%')::int AS top10_count,
       count(*) FILTER (WHERE provisional_population_priority_band = '일반')::int AS normal_count,
       max(prediction_as_of)::text AS prediction_as_of,
       min(target_week_start)::text AS target_week_start,
       max(target_week_end)::text AS target_week_end,
       count(*) FILTER (WHERE temporal_status = 'stale_target_week')::int AS stale_count
  FROM industrial_safety.v_llm_firm_safety_context`;

function ratio(count: number, total: number): number | null {
  return total > 0 ? Number(((count / total) * 100).toFixed(2)) : null;
}

function share(key: string, label: string, count: number, total: number, tone: BatchGradeShare["tone"]): BatchGradeShare {
  return { key, label, count, ratio: ratio(count, total), tone };
}

function unavailable(error: unknown): BatchGradeDistribution {
  const reason = error instanceof ServiceError && error.code === "DATABASE_NOT_CONFIGURED"
    ? "읽기 전용 DB 연결이 설정되지 않았습니다."
    : "현재 읽기 권한으로 이 집계를 읽지 못했습니다.";
  return { status: "unavailable", reason };
}

/** 한국 시각 기준 오늘(YYYY-MM-DD). */
export function seoulToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

/** target_month(YYYY-MM-01)의 마지막 날이 지났는가. */
function monthPassed(targetMonth: string, today: string): boolean {
  const [year, month] = targetMonth.slice(0, 7).split("-").map(Number);
  if (!year || !month) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return today > lastDay;
}

async function readWageGrades(batchId: number): Promise<{ row: WageGradeRow; computedAt: string }> {
  const [row] = await queryReadOnly<WageGradeRow>(WAGE_GRADE_SQL, [batchId], {
    relation: "public.scored_active+public.safe_recommendation (batch grades)",
  });
  if (!row || typeof row.total !== "number") throw new Error("empty wage grade result");
  return { row, computedAt: new Date().toISOString() };
}

async function readSafetyGrades(): Promise<{ row: SafetyGradeRow; computedAt: string }> {
  const [row] = await queryReadOnly<SafetyGradeRow>(SAFETY_GRADE_SQL, [], {
    relation: "industrial_safety.v_llm_firm_safety_context (batch grades)",
  });
  if (!row || typeof row.total !== "number") throw new Error("empty safety grade result");
  return { row, computedAt: new Date().toISOString() };
}

export async function buildWageDomain(current: BatchStatus | null, today: string): Promise<BatchDomainStatus> {
  let grades: BatchGradeDistribution;
  let countedRows: number | null = null;
  if (!current) {
    grades = { status: "unavailable", reason: "서비스 중인 배치가 없습니다." };
  } else {
    try {
      const { row, computedAt } = await cachedAggregate(
        `batch-status:wage:${current.batch_id}:${current.ingested_at}`,
        DOMAIN_CACHE_TTL_MS,
        () => readWageGrades(current.batch_id),
      );
      countedRows = row.total;
      grades = {
        status: "ok",
        total: row.total,
        computed_at: computedAt,
        items: [
          share("normal", "뚜렷한 이상 신호 없음", row.normal_count, row.total, "neutral"),
          share("watch", "안전 신호 미확인", row.watch_count, row.total, "neutral"),
          share("review", "우선 확인 필요", row.review_count, row.total, "priority"),
          share("unknown", "분석 자료 부족", row.unknown_count, row.total, "insufficient"),
        ],
      };
    } catch (error) {
      grades = unavailable(error);
    }
  }

  const validUntil = getNextBatchDueDate(current?.ingested_date ?? null);
  const stale = current?.target_month ? monthPassed(current.target_month, today) : null;
  return {
    domain: "wage",
    title: "임금체불",
    as_of: current?.data_as_of ?? null,
    as_of_label: "배치 기준월(as_of)",
    target: current?.target_month ?? null,
    target_label: "예측 대상 월(6개월 뒤)",
    stale,
    stale_detail: stale === null ? "서비스 배치의 예측 대상 월을 확인하지 못했습니다." : stale ? "예측 대상 월이 이미 지났습니다." : null,
    as_of_window_check: "unverifiable",
    row_count: current ? current.n_scored : null,
    row_count_source: countedRows !== null && current && countedRows !== current.n_scored
      ? `batches.n_scored — 실제 scored_active 행수 ${countedRows.toLocaleString("ko-KR")}와 다름(적재 확인 필요)`
      : "batches.n_scored (채점 대상 전체)",
    reference_row_count: REFERENCE_ROW_COUNTS.wage,
    grades,
    grade_basis: "분모는 채점 대상 전체입니다. 판정 없음은 '분석 자료 부족'에 포함합니다(개별 조회 화면과 같은 기준).",
    valid_until: validUntil,
    valid_until_note: validUntil === null
      ? "갱신 확인 필요 — 다음 배치 예정일을 저장하는 필드가 없습니다."
      : validUntil < today
        ? "기한 지남 — 갱신 확인 필요 (적재일+1개월 추정, 저장 필드 없음)"
        : "적재일+1개월 추정치입니다. 확정된 예정일이 아닙니다.",
  };
}

export async function buildSafetyDomain(today: string): Promise<BatchDomainStatus> {
  let grades: BatchGradeDistribution;
  let row: SafetyGradeRow | null = null;
  try {
    // 대상 주 경과(temporal_status)는 날짜에 따라 바뀌므로 날짜를 키에 넣는다.
    const result = await cachedAggregate(`batch-status:safety:${today}`, DOMAIN_CACHE_TTL_MS, readSafetyGrades);
    row = result.row;
    grades = {
      status: "ok",
      total: row.total,
      computed_at: result.computedAt,
      items: [
        share("top1", "상위1%", row.top1_count, row.total, "priority"),
        share("top5", "상위5%", row.top5_count, row.total, "priority"),
        share("top10", "상위10%", row.top10_count, row.total, "priority"),
        share("normal", "일반", row.normal_count, row.total, "neutral"),
      ],
    };
  } catch (error) {
    grades = unavailable(error);
  }

  const target = row?.target_week_start && row.target_week_end ? `${row.target_week_start} ~ ${row.target_week_end}` : null;
  const stale = row ? row.total > 0 && row.stale_count > 0 : null;
  let staleDetail: string | null = null;
  if (!row) staleDetail = "산업재해 결과를 읽지 못해 대상 주 경과 여부를 판단하지 못했습니다.";
  else if (stale) {
    staleDetail = `예측 대상 주가 이미 지났습니다 (stale_target_week ${row.stale_count.toLocaleString("ko-KR")}곳 / ${row.total.toLocaleString("ko-KR")}곳).`;
  }
  return {
    domain: "safety",
    title: "산업재해",
    as_of: row?.prediction_as_of ?? null,
    as_of_label: "관측 기준일(prediction_as_of)",
    target,
    target_label: "예측 대상 주",
    stale,
    stale_detail: staleDetail,
    as_of_window_check: "unverifiable",
    row_count: row?.total ?? null,
    row_count_source: "industrial_safety.v_llm_firm_safety_context 행수",
    reference_row_count: REFERENCE_ROW_COUNTS.safety,
    grades,
    grade_basis: "밴드는 전국 전체 기준입니다. 지역·업종 필터를 걸어도 재계산하지 않습니다.",
    valid_until: null,
    valid_until_note: "갱신 확인 필요 — 산업재해 결과에는 다음 갱신 예정일 필드가 없습니다.",
  };
}

export async function listBatchStatuses(now: Date = new Date()): Promise<BatchStatusListResponse> {
  const rows = await queryReadOnly<BatchStatus>(
    `WITH current_batch AS (
       SELECT id
         FROM public.batches
        ${LATEST_BATCH_ORDER_SQL}
     )
     SELECT b.id AS batch_id,
            b.as_of_date::text AS data_as_of,
            b.target_month::text,
            b.model_version,
            b.model_sha,
            b.ingested_at::text,
            to_char(b.ingested_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS ingested_date,
            b.source,
            b.n_scored,
            b.n_queue,
            b.n_safe,
            COALESCE(b.id = current_batch.id, false) AS is_active,
            b.is_active AS is_pinned
       FROM public.batches b
       LEFT JOIN current_batch ON true
      ORDER BY b.as_of_date DESC NULLS LAST, b.ingested_at DESC, b.id DESC`,
    [],
    { relation: "public.batches" },
  );

  const current = rows.find((row) => row.is_active) ?? null;
  const today = seoulToday(now);
  const domains = await Promise.all([buildWageDomain(current, today), buildSafetyDomain(today)]);

  return {
    selection_mode: rows.some((row) => row.is_pinned) ? "pinned" : "auto",
    current,
    batches: rows,
    domains,
    drift: LATEST_DRIFT_CHECK,
    generated_at: now.toISOString(),
  };
}
