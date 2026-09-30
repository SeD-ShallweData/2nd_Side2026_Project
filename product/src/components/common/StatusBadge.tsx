"use client";

import type { SignalLevel, WageVerdict } from "@/domain/risk";
import { EXCLUDED_VERDICT_META, getWageStatusMeta, SIGNAL_STATUS_META } from "@/domain/riskPresentation";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

// 배제 판정 값(서버 데이터)을 사전 키로 옮긴다. 값 자체는 번역하지 않는다.
const EXCLUDED_LABEL_KEY: Record<keyof typeof EXCLUDED_VERDICT_META, "wageList" | "taxArrears" | "insuranceArrears"> = {
  "배제_임금체불공개": "wageList",
  "배제_공개체납": "taxArrears",
  "배제_4대보험체납(door1)": "insuranceArrears",
};

export function StatusBadge({ level, verdict, kind }: { level: SignalLevel; verdict?: WageVerdict | null; kind?: "wage" | "safety" }) {
  const m = useMessages(commonMessages).status;
  const isWage = kind === "wage" || (!kind && verdict);
  const meta = isWage ? getWageStatusMeta(level, verdict) : SIGNAL_STATUS_META[level];
  let label: string;
  if (isWage && verdict && verdict in EXCLUDED_LABEL_KEY) {
    label = m.excluded[EXCLUDED_LABEL_KEY[verdict as keyof typeof EXCLUDED_LABEL_KEY]];
  } else if (isWage && level === "watch") {
    label = m.wageWatch;
  } else {
    label = m.signal[level];
  }
  return <span className={`status-badge ${meta.className}`}>{label}</span>;
}
