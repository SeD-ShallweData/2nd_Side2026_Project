import type { SignalLevel, WageVerdict } from "@/domain/risk";
import { getWageStatusMeta, SIGNAL_STATUS_META } from "@/domain/riskPresentation";

export function StatusBadge({ level, verdict, kind }: { level: SignalLevel; verdict?: WageVerdict | null; kind?: "wage" | "safety" }) {
  const meta = kind === "wage" || (!kind && verdict) ? getWageStatusMeta(level, verdict) : SIGNAL_STATUS_META[level];
  return <span className={`status-badge ${meta.className}`}>{meta.label}</span>;
}
