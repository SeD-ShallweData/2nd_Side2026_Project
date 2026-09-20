/**
 * SHAP 위험사유(`inspector_queue.reasons`) 표시용 한글 라벨.
 *
 * docs/data-contract/wage-risk.md §4.6.1 피처 사전 39종 전체를 그대로 옮긴다.
 * 모델이 고정돼 있어(`model_version = door1-voting-39f-v1`) 사유는 이 39종 밖에서
 * 나오지 않는다. `model_version`이 바뀌면 이 사전도 함께 갱신해야 한다.
 *
 * `reasons` 원본에는 영문 피처명과 한글 라벨이 섞여 있다(§4.6 실측) — 어떤 배치는
 * 이미 한글 라벨을 그대로 저장했다. 그래서 값 자체가 이미 아래 라벨 중 하나와
 * 같으면 그대로 쓰고, 영문 피처명이면 사전으로 옮긴다.
 */
export const RISK_REASON_LABELS: Record<string, string> = {
  // door1 (4대보험 체납) — 7종
  door1_ever: "4대보험 체납이력",
  door1_maxamt: "체납액",
  door1_maxmonths: "체납 지속기간",
  door1_n_insu: "체납 보험 종수",
  door1_health: "건강보험 체납",
  door1_pension: "국민연금 체납",
  door1_labor: "고용·산재 체납",
  // 이직 · 인력 대체 — 8종
  turnover_avg_12m: "평균 퇴사율",
  turnover_avg_3m: "최근 퇴사율",
  turnover_max_12m: "최고 퇴사율",
  turnover_std_12m: "퇴사율 변동",
  turnover_momentum: "퇴사율 가속",
  replacement_avg_12m: "인력 대체율",
  replacement_avg_3m: "최근 인력 대체율",
  replacement_min_12m: "최저 인력 대체율",
  // 인원 규모 · 변화 — 6종
  emp_change_3m: "3개월 인원변화",
  emp_change_6m: "6개월 인원변화",
  emp_change_12m: "12개월 인원변화",
  emp_volatility: "인원변동성",
  zero_emp_months: "인원 0 개월수",
  log_emp_count: "사업장 규모",
  // 급여 — 5종
  salary_avg_12m: "급여수준",
  salary_last: "최근 급여",
  salary_change_6m: "급여삭감",
  salary_change_12m: "급여 12개월 변화",
  salary_drop_consecutive: "연속 급여하락",
  // 고지금액 · 납부 행태(strong7) — 7종
  nf_bill_last_ratio: "최근 고지금액 수준",
  nf_bill_maxdrop: "고지금액 급락",
  nf_bill_cv: "고지금액 변동",
  nf_pc_slope: "1인당 납부액 추세",
  nf_pay_divergence: "인원-납부 괴리",
  nf_emp_slope: "인원 추세",
  nf_drawdown: "정점대비 인원낙폭",
  // 업력 · 속성 · 데이터 신뢰도 — 6종
  firm_age_months: "업력",
  sido_code: "지역",
  industry_category: "업종",
  has_missing_recent_3m: "최근 신고 누락",
  imputed_months_count: "(데이터 결측 개월수)",
  imputed_ratio: "(데이터 결측 비율)",
};

/**
 * 사유 목록에서 아예 빼는 2종(§4.6 표시 규칙 2) — 모델 점수엔 기여하지만
 * "결측 보정 비율 높음"처럼 노출하면 사업장 위험이 아니라 데이터 사정으로 읽힌다.
 */
const EXCLUDED_REASON_KEYS = new Set(["imputed_months_count", "imputed_ratio"]);

const KNOWN_KOREAN_LABELS = new Set(Object.values(RISK_REASON_LABELS));

function isExcludedReason(raw: string): boolean {
  return EXCLUDED_REASON_KEYS.has(raw) || raw === RISK_REASON_LABELS.imputed_months_count || raw === RISK_REASON_LABELS.imputed_ratio;
}

/**
 * 원본 사유 하나를 화면용 한글 라벨로 바꾼다.
 * - 39종 사전에 없는 값은 뜻을 지어내지 않고 "사유 확인 필요"로 표기한다(표시 규칙 4).
 * - 🔴 데이터 신뢰도 2종은 호출부에서 걸러낼 수 있도록 null을 돌려준다.
 */
export function labelRiskReason(raw: string): string | null {
  if (isExcludedReason(raw)) return null;
  if (raw in RISK_REASON_LABELS) return RISK_REASON_LABELS[raw];
  if (KNOWN_KOREAN_LABELS.has(raw)) return raw;
  return "사유 확인 필요";
}

/** 사유 배열 전체를 화면용 라벨로 바꾸고, 표시 제외 대상은 뺀다. */
export function labelRiskReasons(raw: readonly string[]): string[] {
  return raw.map(labelRiskReason).filter((label): label is string => label !== null);
}
