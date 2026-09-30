"use client";

import { useCallback, useEffect, useState } from "react";
import { OpsReasonForm } from "@/components/admin/OpsReasonForm";
import { BatchDomainPanels, DriftCheckCard } from "@/components/inspector/BatchDefinitionPanels";
import type { BatchStatus, BatchStatusListResponse } from "@/domain/batch";
import { postJson, readApiResponse } from "@/utils/clientApi";

function dateLabel(value: string | null, fallback = "미확정"): string {
  if (!value) return fallback;
  return value.slice(0, 7).replace("-", ".");
}

function timestampLabel(value: string): string {
  return new Date(value).toLocaleString("ko-KR");
}

/** 적재가 끝난 배치만 전환 후보다. 최종 판정은 DB 함수가 다시 한다. */
function canServe(batch: BatchStatus): boolean {
  return Boolean(batch.data_as_of) && batch.n_scored > 0 && batch.n_queue > 0 && batch.n_safe > 0;
}

type PendingChange = { kind: "activate"; batch: BatchStatus } | { kind: "deactivate" };

interface BatchStatusPageProps {
  endpoint?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
}

export function BatchStatusPage({
  endpoint = "/api/inspector/batches",
  eyebrow = "Machine Learning 운영 상태",
  title = "배치 현황",
  description = "서비스가 참조하는 Machine Learning 배치와 과거 적재 이력을 확인합니다.",
}: BatchStatusPageProps = {}) {
  const [data, setData] = useState<BatchStatusListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetch(endpoint, { signal, cache: "no-store" })
        .then((response) => readApiResponse<BatchStatusListResponse>(response))
        .then((result) => {
          setData(result);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setError(caught instanceof Error ? caught.message : "배치 현황을 불러오지 못했습니다.");
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [endpoint],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function applyChange(reason: string) {
    if (!pending) return;
    setBusy(true);
    setChangeError(null);
    try {
      if (pending.kind === "activate") {
        await postJson(`/api/admin/batches/${pending.batch.batch_id}/activate`, { reason });
        setNotice(`서비스 배치를 배치 ${pending.batch.batch_id}(기준월 ${dateLabel(pending.batch.data_as_of)})에 고정했습니다.`);
      } else {
        await postJson("/api/admin/batches/deactivate", { reason });
        setNotice("고정을 해제했습니다. 기준월이 가장 최신인 배치를 서비스합니다.");
      }
      setPending(null);
      await load();
    } catch (caught) {
      setChangeError(caught instanceof Error ? caught.message : "변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const batches = data?.batches ?? [];
  const manageable = data?.manageable === true;
  const pinned = data?.selection_mode === "pinned";
  const current = data?.current ?? null;

  return (
    <main className="shell inspector-content batch-status-page">
      <div className="inspector-page-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      {loading ? <div className="batch-state-card">배치 목록을 불러오는 중입니다.</div> : null}
      {error ? <div className="batch-state-card batch-state-error" role="alert"><strong>배치 현황을 확인하지 못했습니다.</strong><span>{error}</span></div> : null}
      {!loading && !error && data?.drift ? <DriftCheckCard record={data.drift} /> : null}
      {!loading && !error && data?.domains?.length ? <BatchDomainPanels domains={data.domains} /> : null}
      {!loading && !error && batches.length === 0 ? <div className="batch-state-card">적재된 배치가 없습니다.</div> : null}
      {!loading && !error && batches.length > 0 ? (
        <>
          <section className={`batch-mode-card ${pinned ? "is-pinned" : ""}`} aria-label="서비스 배치 선택 방식">
            <div>
              <span className="batch-mode-label">{pinned ? "고정" : "자동"}</span>
              <strong>
                {current
                  ? `배치 ${current.batch_id} · 기준월 ${dateLabel(current.data_as_of)} 서비스 중`
                  : "서비스 중인 배치가 없습니다"}
              </strong>
              <p>
                {pinned
                  ? "운영자가 고정한 배치를 서비스합니다. 새 배치가 적재돼도 고정을 해제하기 전까지 바뀌지 않습니다."
                  : "기준월이 가장 최신인 배치를 자동으로 서비스합니다."}
              </p>
            </div>
            {manageable && pinned && !pending ? (
              <button type="button" className="button button-outline" onClick={() => { setPending({ kind: "deactivate" }); setChangeError(null); setNotice(null); }}>
                고정 해제(자동으로)
              </button>
            ) : null}
          </section>

          {notice ? <p className="ops-notice" role="status">{notice}</p> : null}

          {pending ? (
            <OpsReasonForm
              summary={
                pending.kind === "activate"
                  ? `서비스 배치를 배치 ${pending.batch.batch_id}(기준월 ${dateLabel(pending.batch.data_as_of)})에 고정합니다. 공개 조회·점검 화면·AI 답변이 모두 이 배치를 씁니다.`
                  : "고정을 해제하고 기준월이 가장 최신인 배치로 돌아갑니다."
              }
              confirmLabel={pending.kind === "activate" ? "이 배치로 전환" : "고정 해제"}
              busy={busy}
              error={changeError}
              onConfirm={(reason) => void applyChange(reason)}
              onCancel={() => { setPending(null); setChangeError(null); }}
            />
          ) : null}

          <section className="batch-table-panel" aria-label="Machine Learning 배치 목록">
            <div className="batch-table-scroll">
              <table className="batch-status-table">
                <thead><tr><th>상태</th><th>배치 ID</th><th>기준월</th><th>예측 대상월</th><th>모델 버전</th><th>적재 시각</th><th>규모</th>{manageable ? <th>관리</th> : null}</tr></thead>
                <tbody>{batches.map((batch) => (
                  <tr key={batch.batch_id} className={batch.is_active ? "is-active" : undefined}>
                    <td><span className={`batch-status-pill ${batch.is_active ? "is-active" : "is-archived"}`}>{batch.is_active ? (batch.is_pinned ? "서비스 중 · 고정" : "서비스 중") : batch.data_as_of ? "과거 배치" : "후보 제외"}</span></td>
                    <td>{batch.batch_id}</td>
                    <td>{dateLabel(batch.data_as_of, "기준월 미확정")}</td>
                    <td>{dateLabel(batch.target_month)}</td>
                    <td>{batch.model_version}{batch.model_sha ? <span>sha {batch.model_sha.slice(0, 8)}</span> : null}</td>
                    <td>{timestampLabel(batch.ingested_at)}</td>
                    <td className="batch-scale-cell"><div><span>채점 {batch.n_scored.toLocaleString("ko-KR")}</span><span>위험큐 {batch.n_queue.toLocaleString("ko-KR")}</span><span>안정판정 {batch.n_safe.toLocaleString("ko-KR")}</span></div></td>
                    {manageable ? (
                      <td>
                        {!batch.is_active && canServe(batch) ? (
                          <button
                            type="button"
                            className="button button-outline batch-switch-button"
                            disabled={busy}
                            onClick={() => { setPending({ kind: "activate", batch }); setChangeError(null); setNotice(null); }}
                          >
                            이 배치로 전환
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="batch-table-note">
              {manageable || pinned
                ? "고정이 없으면 기준월·적재 시각·배치 ID 순으로 가장 최신인 한 건을 서비스합니다. 전환·해제는 사유와 함께 감사 기록에 남습니다."
                : "서비스 중 표시는 기준월·적재 시각·배치 ID의 결정적 정렬 결과 가장 최신인 한 건에만 부여됩니다."}
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
