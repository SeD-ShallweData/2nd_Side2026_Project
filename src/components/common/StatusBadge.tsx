import type { SignalLevel } from "@/domain/risk";

const STATUS_META: Record<SignalLevel, { label: string; className: string }> = {
  normal: { label: "뚜렷한 이상 신호 없음", className: "status-neutral" },
  watch: { label: "추가 확인 권장", className: "status-watch" },
  review: { label: "우선 확인 필요", className: "status-review" },
  unknown: { label: "분석 자료 부족", className: "status-unknown" },
};

export function StatusBadge({ level }: { level: SignalLevel }) {
  const meta = STATUS_META[level];
  return <span className={`status-badge ${meta.className}`}>{meta.label}</span>;
}
