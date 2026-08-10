import type { SignalLevel } from "@/domain/risk";

export const SIGNAL_STATUS_META: Record<SignalLevel, { label: string; className: string }> = {
  normal: { label: "뚜렷한 이상 신호 없음", className: "status-neutral" },
  watch: { label: "추가 확인 권장", className: "status-watch" },
  review: { label: "우선 확인 필요", className: "status-review" },
  unknown: { label: "분석 자료 부족", className: "status-unknown" },
};

export function getSignalStatusLabel(level: SignalLevel): string {
  return SIGNAL_STATUS_META[level].label;
}
