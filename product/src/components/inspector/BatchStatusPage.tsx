"use client";

import { useEffect, useState } from "react";
import type { BatchStatus, BatchStatusListResponse } from "@/domain/batch";
import { readApiResponse } from "@/utils/clientApi";

function dateLabel(value: string | null): string {
  if (!value) return "미확정";
  return value.slice(0, 7).replace("-", ".");
}

function timestampLabel(value: string): string {
  return new Date(value).toLocaleString("ko-KR");
}

export function BatchStatusPage() {
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/inspector/batches", { signal: controller.signal, cache: "no-store" })
      .then((response) => readApiResponse<BatchStatusListResponse>(response))
      .then((result) => setBatches(result.batches))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "배치 현황을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="shell inspector-content batch-status-page">
      <div className="inspector-page-heading">
        <div>
          <span className="eyebrow">ML 운영 상태</span>
          <h1>배치 현황</h1>
          <p>서비스가 참조하는 ML 배치와 과거 적재 이력을 확인합니다.</p>
        </div>
        <span className="inspector-private-badge">DB 변경 없음</span>
      </div>
      {loading ? <div className="batch-state-card">배치 목록을 불러오는 중입니다.</div> : null}
      {error ? <div className="batch-state-card batch-state-error" role="alert"><strong>배치 현황을 확인하지 못했습니다.</strong><span>{error}</span></div> : null}
      {!loading && !error && batches.length === 0 ? <div className="batch-state-card">적재된 배치가 없습니다.</div> : null}
      {!loading && !error && batches.length > 0 ? (
        <section className="batch-table-panel" aria-label="ML 배치 목록">
          <div className="batch-table-scroll">
            <table className="batch-status-table">
              <thead><tr><th>상태</th><th>배치 ID</th><th>기준월</th><th>예측 대상월</th><th>모델 버전</th><th>적재 시각</th><th>규모</th></tr></thead>
              <tbody>{batches.map((batch) => <tr key={batch.batch_id} className={batch.is_active ? "is-active" : undefined}><td><span className={`batch-status-pill ${batch.is_active ? "is-active" : "is-archived"}`}>{batch.is_active ? "서비스 중" : "과거 배치"}</span></td><td>{batch.batch_id}</td><td>{dateLabel(batch.data_as_of)}</td><td>{dateLabel(batch.target_month)}</td><td>{batch.model_version}</td><td>{timestampLabel(batch.ingested_at)}</td><td><span>채점 {batch.n_scored.toLocaleString("ko-KR")}</span><span>위험큐 {batch.n_queue.toLocaleString("ko-KR")}</span><span>안정판정 {batch.n_safe.toLocaleString("ko-KR")}</span></td></tr>)}</tbody>
            </table>
          </div>
          <p className="batch-table-note">서비스 중 표시는 기준월·적재 시각·배치 ID의 결정적 정렬 결과 가장 최신인 한 건에만 부여됩니다.</p>
        </section>
      ) : null}
    </main>
  );
}
