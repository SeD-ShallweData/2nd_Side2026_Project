"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { OpsReasonForm } from "@/components/admin/OpsReasonForm";
import { isServableBatch, type BatchStatus, type BatchStatusListResponse } from "@/domain/batch";
import { postJson, readApiResponse } from "@/utils/clientApi";

/*
 * 운영 관리자용 모델 운영 패널 — 화면→ML 운영 명령.
 *
 * 무엇이 실제로 동작하나 (docs/mlops/ml-db-data-contract.md "운영 명령(화면→ML)")
 *  - 배치 승인: 실제 동작. /api/admin/batches/{id}/activate · /deactivate 를 부르고, 서버는
 *    admin 세션·같은 출처·사유(2~300자)를 확인한 뒤 wg_ops 로 ops_activate_batch /
 *    ops_deactivate_batches 를 실행해 ops_audit_log 에 남긴다. /inspector/batches 와 같은 경로다.
 *  - 등급 임계값·재학습: 설계안. 받을 서버·파이프라인 자리가 없어 아무것도 보내지 않는다.
 *    눌러서 성공처럼 보이는 가짜 상태를 만들지 않는다 — 버튼은 비활성이고 화면에 그렇게 적는다.
 */

const BATCHES_ENDPOINT = "/api/admin/batches?fields=batches";

function monthLabel(value: string | null): string {
  return value ? value.slice(0, 7).replace("-", ".") : "기준월 미확정";
}

function batchLabel(batch: BatchStatus): string {
  return `배치 ${batch.batch_id} · 기준월 ${monthLabel(batch.data_as_of)} · ${batch.model_version}`;
}

type Pending = { kind: "activate"; batch: BatchStatus } | { kind: "deactivate" };

export interface MlOperationsPanelViewProps {
  data: BatchStatusListResponse | null;
  loading: boolean;
  loadError: string | null;
  selectedId: number | null;
  pending: Pending | null;
  busy: boolean;
  changeError: string | null;
  notice: string | null;
  onSelect: (batchId: number | null) => void;
  onRequest: (pending: Pending) => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function MlOperationsPanelView({
  data,
  loading,
  loadError,
  selectedId,
  pending,
  busy,
  changeError,
  notice,
  onSelect,
  onRequest,
  onConfirm,
  onCancel,
}: MlOperationsPanelViewProps) {
  const current = data?.current ?? null;
  const pinned = data?.selection_mode === "pinned";
  const manageable = data?.manageable === true;
  const candidates = (data?.batches ?? []).filter((batch) => !batch.is_active && isServableBatch(batch));
  const selected = candidates.find((batch) => batch.batch_id === selectedId) ?? null;

  return (
    <section className="ml-ops-panel" aria-label="모델 운영">
      <header className="ml-ops-head">
        <div>
          <span className="eyebrow">운영 관리자</span>
          <h2>모델 운영</h2>
        </div>
        <span className="ml-ops-scope">배치 승인만 서버 연결 · 임계값·재학습은 설계안</span>
      </header>
      <p className="ml-ops-server-notice" role="note">
        <strong>서버로 보내는 것은 배치 승인(서비스 배치 전환)뿐입니다.</strong> 운영 DB 함수가 실행되고 사유와 함께 감사 기록에 남습니다.
        등급 임계값과 재학습은 설계안이라 버튼을 눌러도 서버에 아무것도 보내지 않으며, 그래서 비활성으로 두었습니다.
      </p>

      <div className="ml-ops-grid">
        <article className="ml-ops-card is-live">
          <h3>배치 승인 <span className="ml-ops-tag is-live">실제 동작</span></h3>
          <p>공개 조회·점검 화면·AI 답변이 쓸 배치를 정합니다. 승인하면 그 배치로 고정되고, 해제하면 기준월이 가장 최신인 배치로 돌아갑니다.</p>
          {loading ? <p className="ml-ops-state">배치 목록을 불러오는 중입니다.</p> : null}
          {loadError ? <p className="field-error" role="alert">배치 목록을 확인하지 못했습니다. {loadError}</p> : null}
          {!loading && !loadError && data ? (
            <>
              <p className="ml-ops-state">
                {current ? <>서비스 중 <strong>{batchLabel(current)}</strong> · {pinned ? "고정" : "자동(최신 기준월)"}</> : "서비스 중인 배치가 없습니다."}
              </p>
              {manageable ? (
                <>
                  {candidates.length > 0 ? (
                    <label className="ml-ops-select">
                      승인할 배치
                      <select
                        value={selectedId ?? ""}
                        disabled={busy || pending !== null}
                        onChange={(event) => onSelect(event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">배치를 고르세요</option>
                        {candidates.map((batch) => <option key={batch.batch_id} value={batch.batch_id}>{batchLabel(batch)}</option>)}
                      </select>
                    </label>
                  ) : <p className="ml-ops-state">전환할 수 있는 다른 배치가 없습니다(적재가 끝난 배치만 후보입니다).</p>}
                  {pending ? (
                    <OpsReasonForm
                      summary={pending.kind === "activate"
                        ? `서비스 배치를 ${batchLabel(pending.batch)}(으)로 고정합니다.`
                        : "고정을 해제하고 기준월이 가장 최신인 배치로 돌아갑니다."}
                      confirmLabel={pending.kind === "activate" ? "승인하고 전환" : "고정 해제"}
                      busy={busy}
                      error={changeError}
                      onConfirm={onConfirm}
                      onCancel={onCancel}
                    />
                  ) : (
                    <div className="ml-ops-actions">
                      <button
                        type="button"
                        className="button button-dark button-small"
                        disabled={!selected || busy}
                        onClick={() => { if (selected) onRequest({ kind: "activate", batch: selected }); }}
                      >
                        승인(전환)
                      </button>
                      {pinned ? (
                        <button type="button" className="button button-outline button-small" disabled={busy} onClick={() => onRequest({ kind: "deactivate" })}>
                          고정 해제
                        </button>
                      ) : null}
                    </div>
                  )}
                </>
              ) : (
                <p className="ml-ops-state" role="note">운영 DB(wg_ops)가 연결되지 않은 서버라 여기서는 전환할 수 없습니다. 상태만 보여 줍니다.</p>
              )}
            </>
          ) : null}
          {notice ? <p className="ops-notice" role="status">{notice}</p> : null}
          <p><Link href="/inspector/batches">배치 현황에서 전체 이력·드리프트·등급 분포 보기 →</Link></p>
        </article>

        <article className="ml-ops-card is-design">
          <h3>등급 임계값 <span className="ml-ops-tag">설계안 · 서버 미연결</span></h3>
          <p>모델 원점수 순위 몇 번째까지를 각 등급으로 볼지 정하는 기능입니다. 지금 등급 경계는 ML 파이프라인이 배치를 만들 때 정하며(risk_tier_meta), 이 화면에서 바꿀 수 없습니다.</p>
          <p className="ml-ops-state">설계: 값을 저장하면 &ldquo;다음 배치부터 적용&rdquo; 요청으로 쌓이고, ML 담당이 다음 학습에 반영합니다. 받을 자리(요청 테이블·파이프라인 입력)는 아직 없습니다.</p>
          <div className="ml-ops-actions">
            <button type="button" className="button button-outline button-small" disabled aria-disabled="true">
              임계값 변경 요청 (미구현)
            </button>
          </div>
        </article>

        <article className="ml-ops-card is-design">
          <h3>재학습 <span className="ml-ops-tag">설계안 · 서버 미연결</span></h3>
          <p>지금 재학습은 ML 담당이 파이프라인을 직접 돌리고 결과를 적재(ingest.sh)하면 새 배치가 생기는 방식입니다. 새 배치는 &ldquo;배치 승인&rdquo;으로 서비스에 내보냅니다.</p>
          <p className="ml-ops-state">설계: 화면에서 재학습 요청을 대기열에 올리고 진행 상태를 읽어 오는 기능입니다. 요청을 받을 서버가 없어 진행률을 보여 주지 않습니다.</p>
          <div className="ml-ops-actions">
            <button type="button" className="button button-outline button-small" disabled aria-disabled="true">
              재학습 요청 (미구현)
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export function MlOperationsPanel() {
  const [data, setData] = useState<BatchStatusListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetch(BATCHES_ENDPOINT, { signal, cache: "no-store" })
        .then((response) => readApiResponse<BatchStatusListResponse>(response))
        .then((result) => { setData(result); setLoadError(null); })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setLoadError(caught instanceof Error ? caught.message : "배치 목록을 불러오지 못했습니다.");
        })
        .finally(() => { if (!signal?.aborted) setLoading(false); }),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function confirm(reason: string) {
    if (!pending) return;
    setBusy(true);
    setChangeError(null);
    try {
      if (pending.kind === "activate") {
        await postJson(`/api/admin/batches/${pending.batch.batch_id}/activate`, { reason });
        setNotice(`${batchLabel(pending.batch)}(으)로 전환했습니다. 감사 기록에 남았습니다.`);
      } else {
        await postJson("/api/admin/batches/deactivate", { reason });
        setNotice("고정을 해제했습니다. 기준월이 가장 최신인 배치를 서비스합니다.");
      }
      setPending(null);
      setSelectedId(null);
      await load();
    } catch (caught) {
      // 실패는 실패로 보여 준다. 화면 상태를 성공으로 바꾸지 않는다.
      setChangeError(caught instanceof Error ? caught.message : "전환하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <MlOperationsPanelView
      data={data}
      loading={loading}
      loadError={loadError}
      selectedId={selectedId}
      pending={pending}
      busy={busy}
      changeError={changeError}
      notice={notice}
      onSelect={setSelectedId}
      onRequest={(next) => { setPending(next); setChangeError(null); setNotice(null); }}
      onConfirm={(reason) => void confirm(reason)}
      onCancel={() => { setPending(null); setChangeError(null); }}
    />
  );
}
