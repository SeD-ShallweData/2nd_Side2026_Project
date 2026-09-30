export interface BatchStatus {
  batch_id: number;
  data_as_of: string | null;
  target_month: string | null;
  model_version: string;
  model_sha: string | null;
  ingested_at: string;
  source: string | null;
  n_scored: number;
  n_queue: number;
  n_safe: number;
  /** 적재일(한국 시각 기준 YYYY-MM-DD). 다음 배치 예정일(추정) 계산에 쓴다. */
  ingested_date?: string | null;
  /** 지금 서비스에 쓰이는 배치인가(고정이든 자동이든). */
  is_active: boolean;
  /** 운영자가 고정한 배치인가. */
  is_pinned: boolean;
}

export interface BatchStatusListResponse {
  /** pinned: 운영자가 고정한 배치를 서비스한다. auto: 기준월이 가장 최신인 배치를 서비스한다. */
  selection_mode: "auto" | "pinned";
  current: BatchStatus | null;
  batches: BatchStatus[];
  generated_at: string;
  /** 정의서(docs/mlops/MLOps_배치현황정의서.md)의 임금체불·산업재해 현황. 항상 분리해서 보여 준다(합산 금지). */
  domains?: BatchDomainStatus[];
  /** 최근 스키마 드리프트 검사 결과(수동 기입, 결정 41번 옵션 C). */
  drift?: DriftCheckRecord;
  /** admin 응답에만 붙는다. 운영 DB(wg_ops)가 연결돼 있어 전환·해제를 할 수 있는가. */
  manageable?: boolean;
}

export type BatchDomain = "wage" | "safety";

/**
 * 등급 한 칸. tone 은 색 규칙을 강제한다.
 * - neutral: 회색·중립. 임금 "안전 신호 미확인"(watch)은 회색만 쓴다(노랑·주황·빨강 금지).
 * - insufficient: 자료 부족. 초록·긍정 아이콘 금지.
 * - priority: 우선 확인(임금 review) 또는 상위 밴드(산업재해).
 * 임금체불 쪽에는 초록(긍정) 톤이 없다.
 */
export interface BatchGradeShare {
  key: string;
  label: string;
  count: number;
  /** 소수 둘째 자리 %. 분모가 0이면 null. */
  ratio: number | null;
  tone: "neutral" | "insufficient" | "priority";
}

export type BatchGradeDistribution =
  | { status: "ok"; total: number; items: BatchGradeShare[]; computed_at: string }
  | { status: "unavailable"; reason: string };

export interface BatchDomainStatus {
  domain: BatchDomain;
  title: string;
  /** §1 as_of. 임금: 배치 기준월(as_of_date). 산업재해: prediction_as_of. */
  as_of: string | null;
  as_of_label: string;
  /** §1 예측 대상. 임금: target_month. 산업재해: target_week 시작~끝. */
  target: string | null;
  target_label: string;
  /** 예측 대상 시점이 이미 지났는가. null 이면 판단에 필요한 값을 읽지 못한 것. */
  stale: boolean | null;
  stale_detail: string | null;
  /** §1 M2 — as_of 가 실제 관측창 종료월과 일치하는지는 파일·DB 만으로 검사할 수 없다. 항상 "⚪ 검사 불가". */
  as_of_window_check: "unverifiable";
  /** §2 적재 행수. 읽지 못하면 null(⚪ 검사 불가). */
  row_count: number | null;
  row_count_source: string;
  /** 정의서 작성 시점(2026-09-11) 기준값. 비교용이며 기대값을 강제하지 않는다. */
  reference_row_count: number;
  /** §3 등급 분포 4종. */
  grades: BatchGradeDistribution;
  grade_basis: string;
  /** §5 유효기간. 저장 필드가 없어 null 일 수 있다 → "갱신 확인 필요". */
  valid_until: string | null;
  valid_until_note: string;
}

export interface DriftCheckRecord {
  /** 결정 41번: 수동 기입만 한다. */
  source: "manual";
  checked_at: string;
  target: string;
  command: string;
  /** check:migration-drift 의 상태 값. aligned 만 "정상", 나머지는 "불일치". */
  result:
    | "aligned"
    | "pending_migrations"
    | "schema_ahead_of_ledger"
    | "partial_schema_application"
    | "applied_schema_mismatch"
    | "ledger_missing"
    | "database_ahead"
    | "ledger_diverged";
  migrations_applied: number | null;
  migrations_expected: number | null;
  last_migration: string | null;
  postconditions_passed: number | null;
  postconditions_total: number | null;
  /** §4 — "정상" 배지 옆에 항상 같이 표기한다. null 은 "미기록". */
  warning_count: number | null;
  unverifiable_count: number | null;
  /** 이 기록 이후 저장소에 병합돼 운영 적용 여부가 기록되지 않은 migration. */
  unrecorded_migrations: string[];
  recorded_by: string;
  notes: string[];
}
