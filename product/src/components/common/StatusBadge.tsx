import type { SignalLevel, WageVerdict } from "@/domain/risk";
import { getWageStatusMeta } from "@/domain/riskPresentation";

export function StatusBadge({ level, verdict }: { level: SignalLevel; verdict?: WageVerdict | null }) {
  const meta = getWageStatusMeta(level, verdict);
  return <span className={`status-badge ${meta.className}`}>{meta.label}</span>;
}
