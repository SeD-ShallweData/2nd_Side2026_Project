import type { Freshness } from "@/domain/risk";

export function DataFreshnessNotice({
  freshness,
  dataAsOf,
  validUntil,
}: {
  freshness: Freshness;
  dataAsOf: string;
  validUntil: string;
}) {
  if (freshness === "expired") {
    return (
      <div className="freshness freshness-expired" role="status">
        <strong>자료 갱신이 필요합니다.</strong>
        <span>
          데이터 기준일 {dataAsOf} · 유효기간 {validUntil}까지
        </span>
      </div>
    );
  }
  return (
    <div className="freshness" role="status">
      <strong>현재 유효한 자료</strong>
      <span>
        데이터 기준일 {dataAsOf} · 유효기간 {validUntil}까지
      </span>
    </div>
  );
}
