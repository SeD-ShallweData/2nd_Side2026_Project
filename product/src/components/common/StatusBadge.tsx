import type { SignalLevel } from "@/domain/risk";
import { SIGNAL_STATUS_META } from "@/domain/riskPresentation";

export function StatusBadge({ level }: { level: SignalLevel }) {
  const meta = SIGNAL_STATUS_META[level];
  return <span className={`status-badge ${meta.className}`}>{meta.label}</span>;
}
