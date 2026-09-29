export function DataFreshnessNotice({
  dataAsOf,
  targetMonth,
}: {
  dataAsOf: string | null;
  targetMonth?: string | null;
}) {
  const dataLabel = dataAsOf ? `데이터 기준 ${dataAsOf}` : "데이터 기준월 미확정";
  return (
    <div className="freshness" role="status">
      <strong>분석 기준</strong>
      <span>{[dataLabel, targetMonth && `예측 대상 ${targetMonth}`].filter(Boolean).join(" · ")}</span>
    </div>
  );
}
