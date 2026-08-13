"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type {
  InspectorCompanyDetail,
  InspectorOverview,
  InspectorQueueItem,
  InspectorSearchResponse,
} from "@/domain/inspector";
import { readApiResponse } from "@/utils/clientApi";

function dateLabel(value: string | null): string {
  if (!value) return "미확정";
  const [year, month] = value.split("-");
  return `${year}.${month}`;
}

function priorityClass(priority: string | null): string {
  if (priority === "긴급") return "critical";
  if (priority === "우선") return "high";
  if (priority === "주의") return "watch";
  return "observe";
}

function QueueTable({ items, onSelect }: { items: InspectorQueueItem[]; onSelect: (id: string) => void }) {
  return (
    <div className="inspector-queue-table-wrap">
      <table className="inspector-queue-table">
        <thead>
          <tr><th>순위</th><th>사업장</th><th>점검 등급</th></tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.company_id}>
              <td><strong>#{item.rank.toLocaleString("ko-KR")}</strong></td>
              <td>
                <button type="button" onClick={() => onSelect(item.company_id)}>{item.company_name}</button>
                <small>{[item.region, item.industry].filter(Boolean).join(" · ") || "지역·업종 정보 없음"}</small>
              </td>
              <td><span className={`inspector-priority priority-${priorityClass(item.grade)}`}>{item.grade}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({ detail }: { detail: InspectorCompanyDetail }) {
  const { wage_risk: wage, indicators } = detail;
  const scoreWidth = wage.model_score === null ? 0 : Math.min(Math.max(wage.model_score * 100, 0), 100);
  const reasonMessage = wage.reasons_status === "not_in_queue"
    ? "최신 위험큐 상위 3,000곳 밖이므로 SHAP 사유가 제공되지 않습니다."
    : "위험큐에는 포함됐지만 저장된 SHAP 사유가 없습니다.";

  return (
    <article className="inspector-detail-card">
      <header className="inspector-detail-head">
        <div>
          <span className="eyebrow">선택 사업장</span>
          <h2>{detail.company.company_name}</h2>
          <p>{[detail.company.region, detail.company.industry, `사업자번호 ${detail.company.masked_business_number}`].filter(Boolean).join(" · ")}</p>
        </div>
        {wage.grade ? (
          <span className={`inspector-priority priority-${priorityClass(wage.grade)}`}>{wage.grade}</span>
        ) : <span className="inspector-priority priority-outside">큐 미포함</span>}
      </header>

      <section className="inspector-score-section">
        <div className="inspector-score-copy">
          <span>임금체불 모델 원점수</span>
          <strong>{wage.model_score === null ? "채점 불가" : wage.model_score.toFixed(4)}</strong>
          <small>{wage.model_score === null ? "정보 부족은 0점과 다릅니다" : "0~1 상대 점수 · 발생 확률 아님"}</small>
        </div>
        <div className="inspector-score-position">
          <div><span style={{ width: `${scoreWidth}%` }} /></div>
          <p>원점수의 상대적 위치를 시각화한 것으로 확률 막대가 아닙니다.</p>
        </div>
        <dl className="inspector-score-meta">
          <div><dt>위험큐 순위</dt><dd>{wage.rank === null ? "상위 3,000 밖" : `${wage.rank.toLocaleString("ko-KR")}위`}</dd></div>
          <div><dt>큐 내부 점검 등급</dt><dd>{wage.grade ?? "해당 없음"}</dd></div>
        </dl>
      </section>

      <div className="inspector-detail-grid">
        <section className="inspector-evidence-card">
          <div className="inspector-card-title"><span>01</span><h3>모델 기여 사유</h3></div>
          {wage.reasons.length > 0 ? (
            <ol className="inspector-reason-list">
              {wage.reasons.map((reason, index) => <li key={`${reason}-${index}`}><span>{index + 1}</span>{reason}</li>)}
            </ol>
          ) : <p className="inspector-empty-copy">{reasonMessage}</p>}
          <p className="inspector-card-note">사유는 모델 피처의 기여 방향이며 위반 사실을 뜻하지 않습니다.</p>
        </section>

        <section className="inspector-evidence-card">
          <div className="inspector-card-title"><span>02</span><h3>확인 신호</h3></div>
          <dl className="inspector-flag-list">
            <div><dt>관측 이력</dt><dd>{indicators.observed_months === null ? "정보 없음" : `${indicators.observed_months}개월`}</dd></div>
            <div><dt>안정 지표</dt><dd>{indicators.green_count === null ? "정보 없음" : `${indicators.green_count}/6`}</dd></div>
            <div><dt>4대보험 체납 이력</dt><dd>{wage.arrears_history === null ? "큐 밖 · 미제공" : wage.arrears_history ? "확인 필요" : "미표시"}</dd></div>
            <div><dt>임금체불 공개 연계</dt><dd>{indicators.wage_exclusion === null ? "정보 없음" : indicators.wage_exclusion ? "연계 있음" : "미연계"}</dd></div>
            <div><dt>공개 체납 연계</dt><dd>{indicators.tax_exclusion === null ? "정보 없음" : indicators.tax_exclusion ? "연계 있음" : "미연계"}</dd></div>
          </dl>
        </section>
      </div>

      <section className="inspector-green-section">
        <div className="inspector-card-title"><span>03</span><h3>안정 지표 세부</h3></div>
        <div className="inspector-green-grid">
          {indicators.green_flags.map((flag) => (
            <div className={flag.value === true ? "is-on" : flag.value === false ? "is-off" : "is-unknown"} key={flag.code}>
              <span>{flag.code}</span><strong>{flag.label}</strong><small>{flag.value === true ? "확인" : flag.value === false ? "미충족" : "정보 없음"}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector-safety-strip">
        <div>
          <span>산업안전 별도 참고</span>
          <strong>{detail.industrial_safety ? `현장 확인 우선순위 ${detail.industrial_safety.priority_band}` : "연결된 공표 결과 없음"}</strong>
          <p>{detail.industrial_safety?.disclaimer ?? "자료가 없다는 사실은 안전하거나 위험하다는 뜻이 아닙니다."}</p>
        </div>
        {detail.industrial_safety ? <small>{detail.industrial_safety.target_week_start} ~ {detail.industrial_safety.target_week_end}</small> : null}
      </section>

      <section className="inspector-batch-strip">
        <dl>
          <div><dt>데이터 기준월</dt><dd>{dateLabel(detail.batch.data_as_of)}</dd></div>
          <div><dt>예측 대상월</dt><dd>{dateLabel(detail.batch.target_month)}</dd></div>
          <div><dt>모델 버전</dt><dd>{detail.batch.model_version}</dd></div>
          <div><dt>적재 시각</dt><dd>{new Date(detail.batch.ingested_at).toLocaleString("ko-KR")}</dd></div>
        </dl>
      </section>

      <div className="inspector-detail-actions">
        <div>
          <strong>추가 분석이 필요한가요?</strong>
          <p>같은 사업장 DB 컨텍스트와 공식 노동법 검색 근거를 두 LLM에 동일하게 전달합니다.</p>
        </div>
        <Link className="button button-dark" href={`/inspector/chat?company_id=${encodeURIComponent(detail.company.company_id)}`}>
          AI 점검 보조 열기 <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

export function InspectorDashboard() {
  const [overview, setOverview] = useState<InspectorOverview | null>(null);
  const [detail, setDetail] = useState<InspectorCompanyDetail | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InspectorSearchResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingQueuePage, setEditingQueuePage] = useState(false);
  const [queuePageDraft, setQueuePageDraft] = useState("");
  const [queuePageValidation, setQueuePageValidation] = useState<string | null>(null);

  async function selectCompany(companyId: string) {
    setLoadingDetail(true);
    setError(null);
    try {
      const response = await fetch(`/api/inspector/companies/${encodeURIComponent(companyId)}`, { cache: "no-store" });
      setDetail(await readApiResponse<InspectorCompanyDetail>(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "사업장 내부 데이터를 불러오지 못했습니다.");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function changeQueuePage(page: number) {
    setLoadingQueue(true);
    setQueuePageValidation(null);
    setError(null);
    try {
      const response = await fetch(`/api/inspector/overview?limit=10&page=${page}`, { cache: "no-store" });
      setOverview(await readApiResponse<InspectorOverview>(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "위험큐 페이지를 불러오지 못했습니다.");
    } finally {
      setLoadingQueue(false);
    }
  }

  function startEditingQueuePage() {
    if (!overview) return;
    setQueuePageDraft(String(overview.queue_pagination.page));
    setQueuePageValidation(null);
    setEditingQueuePage(true);
  }

  function goToQueuePage() {
    if (!overview) return;
    const nextPage = Number(queuePageDraft);
    if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > overview.queue_pagination.total_pages) {
      setQueuePageValidation(`1부터 ${overview.queue_pagination.total_pages} 사이의 페이지를 입력해 주세요.`);
      return;
    }
    setEditingQueuePage(false);
    if (nextPage !== overview.queue_pagination.page) void changeQueuePage(nextPage);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/inspector/overview?limit=10&page=1", { cache: "no-store" });
        const data = await readApiResponse<InspectorOverview>(response);
        if (cancelled) return;
        setOverview(data);
        if (data.top_queue[0]) void selectCompany(data.top_queue[0].company_id);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "감독관 큐를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoadingOverview(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    setSearching(true);
    setError(null);
    try {
      const response = await fetch(`/api/inspector/companies/search?q=${encodeURIComponent(normalized)}&limit=10`, { cache: "no-store" });
      setResults(await readApiResponse<InspectorSearchResponse>(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "사업장을 검색하지 못했습니다.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="inspector-dashboard">
      <section className="inspector-hero">
        <div className="shell inspector-hero-grid">
          <div>
            <span className="eyebrow">Workplace Risk Monitoring</span>
            <h1>확인이 필요한 사업장을<br /><mark>데이터로 먼저 살펴보세요.</mark></h1>
            <p>최신 ML 배치의 감독관 점검 등급과 큐 순위, 실제 SHAP 사유를 한 화면에서 확인하는 내부용 시연 대시보드입니다.</p>
          </div>
          <aside>
            <span>해석 원칙</span>
            <strong>점수는 확률이 아닙니다.</strong>
            <p>점검 등급은 모델 원점수 내림차순 상위 3,000곳의 현장 확인 순서를 구간화한 값입니다.</p>
          </aside>
        </div>
      </section>

      <div className="shell inspector-content">
        {error ? <div className="inspector-alert" role="alert"><strong>데이터를 확인하지 못했습니다.</strong><span>{error}</span></div> : null}

        <section className="inspector-overview" aria-busy={loadingOverview}>
          <div className="inspector-section-head">
            <div><span className="eyebrow">Latest batch</span><h2>점검 현황</h2></div>
            {overview ? <p>{dateLabel(overview.batch.data_as_of)} 데이터 기준 · {dateLabel(overview.batch.target_month)} 예측 대상</p> : null}
          </div>
          <div className="inspector-stat-grid">
            <article><span>전체 채점</span><strong>{overview ? overview.totals.scored.toLocaleString("ko-KR") : "—"}</strong><small>사업장</small></article>
            <article className="stat-queue"><span>감독관 위험큐</span><strong>{overview ? overview.totals.queue.toLocaleString("ko-KR") : "—"}</strong><small>상위 점검 대상</small></article>
            <article className="stat-critical"><span>긴급</span><strong>{overview ? overview.queue_counts.긴급.toLocaleString("ko-KR") : "—"}</strong><small>1~100위</small></article>
            <article className="stat-high"><span>우선</span><strong>{overview ? overview.queue_counts.우선.toLocaleString("ko-KR") : "—"}</strong><small>101~500위</small></article>
          </div>
        </section>

        <section className="inspector-search-section">
          <div className="inspector-section-head">
            <div><span className="eyebrow">Workplace lookup</span><h2>사업장 직접 조회</h2></div>
            <p>동명 사업장은 지역·업종·마스킹 번호를 확인해 직접 선택하세요.</p>
          </div>
          <form className="inspector-search-form" onSubmit={handleSearch}>
            <span aria-hidden="true">⌕</span>
            <label className="sr-only" htmlFor="inspector-company-query">사업장명</label>
            <input id="inspector-company-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사업장명을 입력하세요" maxLength={100} />
            <button className="button button-dark" type="submit" disabled={searching || !query.trim()}>{searching ? "검색 중" : "검색"}</button>
          </form>
          {results ? (
            <div className="inspector-search-results">
              <div><strong>‘{results.query}’ 검색 결과 {results.total}건</strong><button type="button" onClick={() => setResults(null)}>닫기</button></div>
              {results.items.length > 0 ? results.items.map((item) => (
                <button type="button" key={item.company_id} onClick={() => { void selectCompany(item.company_id); setResults(null); }}>
                  <span><strong>{item.company_name}</strong><small>{[item.region, item.industry].filter(Boolean).join(" · ") || "지역·업종 정보 없음"}</small></span>
                  <span>사업자번호 {item.masked_business_number}</span>
                </button>
              )) : <p>일치하는 사업장이 없습니다.</p>}
            </div>
          ) : null}
        </section>

        <div className="inspector-work-grid">
          <section className="inspector-queue-card">
            <div className="inspector-card-head">
              <div><span className="eyebrow">Priority queue</span><h2>위험큐 최상위</h2></div>
              <span>{loadingQueue ? "페이지 이동 중" : "1~100위 · 최신 배치"}</span>
            </div>
            {overview ? (
              <>
                <div className={loadingQueue ? "inspector-queue-loading" : undefined} aria-busy={loadingQueue}>
                  <QueueTable items={overview.top_queue} onSelect={(id) => void selectCompany(id)} />
                </div>
                {overview.queue_pagination.total_pages > 1 ? (
                  <nav className="inspector-queue-pagination" aria-label="위험큐 페이지">
                    <button
                      type="button"
                      disabled={loadingQueue || !overview.queue_pagination.has_previous}
                      onClick={() => void changeQueuePage(overview.queue_pagination.page - 1)}
                    >
                      <span aria-hidden="true">←</span> 이전
                    </button>
                    <span className="inspector-queue-page">
                      {editingQueuePage ? (
                        <input
                          autoFocus
                          type="number"
                          min="1"
                          max={overview.queue_pagination.total_pages}
                          step="1"
                          value={queuePageDraft}
                          aria-label={`이동할 위험큐 페이지, 전체 ${overview.queue_pagination.total_pages}페이지`}
                          onChange={(event) => setQueuePageDraft(event.target.value)}
                          onBlur={goToQueuePage}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              goToQueuePage();
                            }
                            if (event.key === "Escape") {
                              setEditingQueuePage(false);
                              setQueuePageValidation(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="inspector-queue-current-page"
                          aria-label={`현재 ${overview.queue_pagination.page}페이지. 클릭하여 이동할 페이지 입력`}
                          onClick={startEditingQueuePage}
                        >
                          {overview.queue_pagination.page}
                        </button>
                      )}
                      <span>/ {overview.queue_pagination.total_pages} 페이지</span>
                    </span>
                    <button
                      type="button"
                      disabled={loadingQueue || !overview.queue_pagination.has_more}
                      onClick={() => void changeQueuePage(overview.queue_pagination.page + 1)}
                    >
                      다음 <span aria-hidden="true">→</span>
                    </button>
                  </nav>
                ) : null}
                {queuePageValidation ? <p className="inspector-queue-page-error" role="alert">{queuePageValidation}</p> : null}
              </>
            ) : <div className="inspector-loading">위험큐를 불러오는 중입니다.</div>}
          </section>

          <div className="inspector-detail-column" aria-busy={loadingDetail}>
            {loadingDetail ? <div className="inspector-loading inspector-detail-loading"><span className="spinner" />사업장 지표를 불러오는 중입니다.</div> : detail ? <DetailPanel detail={detail} /> : <div className="inspector-empty"><strong>사업장을 선택하세요.</strong><p>검색 결과나 위험큐 행을 누르면 상세 지표가 표시됩니다.</p></div>}
          </div>
        </div>

        <div className="inspector-policy-note">
          <strong>의사결정 보조 자료</strong>
          <p>본 화면은 시연용 내부 프로토타입입니다. 모델 결과만으로 조사 착수·위법 판단·행정처분을 자동 결정하지 않으며 반드시 원자료와 현장 사실을 확인해야 합니다.</p>
        </div>
      </div>
    </div>
  );
}
