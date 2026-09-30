"use client";

import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

export function DataFreshnessNotice({
  dataAsOf,
  targetMonth,
}: {
  dataAsOf: string | null;
  targetMonth?: string | null;
}) {
  const m = useMessages(commonMessages).freshness;
  const dataLabel = dataAsOf ? format(m.dataAsOf, { date: dataAsOf }) : m.dataUnknown;
  return (
    <div className="freshness" role="status">
      <strong>{m.title}</strong>
      <span>{[dataLabel, targetMonth && format(m.target, { month: targetMonth })].filter(Boolean).join(" · ")}</span>
    </div>
  );
}
