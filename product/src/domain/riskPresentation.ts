import type { SignalLevel, WageVerdict } from "@/domain/risk";

export const SIGNAL_STATUS_META: Record<SignalLevel, { label: string; className: string }> = {
  normal: { label: "뚜렷한 이상 신호 없음", className: "status-neutral" },
  watch: { label: "안전 신호 미확인", className: "status-watch" },
  review: { label: "우선 확인 필요", className: "status-review" },
  unknown: { label: "분석 자료 부족", className: "status-unknown" },
};

export const EXCLUDED_VERDICT_META: Record<Extract<WageVerdict, `배제_${string}`>, { label: string; className: string }> = {
  "배제_임금체불공개": { label: "임금체불 공개 명단", className: "status-review-wage" },
  "배제_공개체납": { label: "공개 체납", className: "status-review-tax" },
  "배제_4대보험체납(door1)": { label: "4대보험 체납", className: "status-review-insurance" },
};

export function getWageStatusMeta(level: SignalLevel, verdict?: WageVerdict | null) {
  if (verdict && verdict in EXCLUDED_VERDICT_META) {
    return EXCLUDED_VERDICT_META[verdict as keyof typeof EXCLUDED_VERDICT_META];
  }
  return SIGNAL_STATUS_META[level];
}

/** 실제 공개 명단 연계 결과로 표시하는 임금 지표다. */
export const CONNECTED_WAGE_LISTING_LABEL = "체불사업주 명단";

/** 공개 데이터 계약이 연결될 때까지 값을 추정하지 않는 추가 임금 지표다. */
export const UNCONNECTED_WAGE_OBSERVATION_LABELS = [
  "이직률 (12개월)",
  "고용 추이",
  "데이터 충실도",
] as const;

export function getSignalStatusLabel(level: SignalLevel): string {
  return SIGNAL_STATUS_META[level].label;
}
