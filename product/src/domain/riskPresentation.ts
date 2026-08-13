import type { SignalLevel } from "@/domain/risk";

export const SIGNAL_STATUS_META: Record<SignalLevel, { label: string; className: string }> = {
  normal: { label: "뚜렷한 이상 신호 없음", className: "status-neutral" },
  watch: { label: "추가 확인 권장", className: "status-watch" },
  review: { label: "우선 확인 필요", className: "status-review" },
  unknown: { label: "분석 자료 부족", className: "status-unknown" },
};

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
