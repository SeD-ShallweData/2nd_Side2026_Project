import type { Freshness } from "@/domain/risk";

export function DataFreshnessNotice({
  freshness,
  dataAsOf,
  validUntil,
  targetMonth,
}: {
  freshness: Freshness;
  dataAsOf: string | null;
  validUntil: string | null;
  targetMonth?: string | null;
}) {
  const dataLabel = dataAsOf ? `데이터 기준 ${dataAsOf}` : "데이터 기준월 미확정";
  if (freshness === "unknown" || !validUntil) {
    return (
      <div className="freshness freshness-unknown" role="status">
        <strong>DB 기준 정보를 확인하세요.</strong>
        <span>{[dataLabel, targetMonth && `예측 대상 ${targetMonth}`].filter(Boolean).join(" · ")}</span>
      </div>
    );
  }
  if (freshness === "expired") {
    return (
      <div className="freshness freshness-expired" role="status">
        <strong>자료 갱신이 필요합니다.</strong>
        <span>
          {dataLabel} · 화면 유효기간 {validUntil}까지
        </span>
      </div>
    );
  }
  return (
    <div className="freshness" role="status">
      <strong>현재 유효한 자료</strong>
      <span>
        {dataLabel} · 화면 유효기간 {validUntil}까지
      </span>
    </div>
  );
}
