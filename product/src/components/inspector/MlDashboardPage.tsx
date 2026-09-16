"use client";

import { useEffect, useState } from "react";
import type { MlDashboardResponse, MlDashboardTab } from "@/domain/mlDashboard";
import { readApiResponse } from "@/utils/clientApi";

function percent(value: number | null): string {
  return value === null ? "비공개" : `${value.toFixed(2)}%`;
}

export function MlDashboardPage() {
  const [tab, setTab] = useState<MlDashboardTab>("wage");
  const [region, setRegion] = useState("");
  const [industry, setIndustry] = useState("");
  const [data, setData] = useState<MlDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ tab });
    if (region) params.set("region", region);
    if (industry) params.set("industry", industry);
    fetch(`/api/inspector/ml-dashboard?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => readApiResponse<MlDashboardResponse>(response))
      .then((result) => { setData(result); setError(null); })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "ML 대시보드를 불러오지 못했습니다.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, region, industry]);

  function changeTab(nextTab: MlDashboardTab) {
    setLoading(true);
    setTab(nextTab);
    setRegion("");
    setIndustry("");
  }

  function changeFilter(kind: "region" | "industry", value: string) {
    setLoading(true);
    if (kind === "region") setRegion(value);
    else setIndustry(value);
  }

  return (
    <main className="inspector-content ml-dashboard-page">
      <div className="inspector-page-heading"><div><span className="eyebrow">읽기 전용 · 집계 화면</span><h1>ML 대시보드</h1><p>지역·업종별 분포를 확인합니다. 개별 사업장 값과 점수는 표시하지 않습니다.</p></div><span className="inspector-private-badge">개별 값 비노출</span></div>
      <div className="ml-dashboard-tabs" role="tablist" aria-label="ML 집계 종류"><button type="button" role="tab" aria-selected={tab === "wage"} className={tab === "wage" ? "is-active" : ""} onClick={() => changeTab("wage")}>임금체불 확인 신호</button><button type="button" role="tab" aria-selected={tab === "safety"} className={tab === "safety" ? "is-active" : ""} onClick={() => changeTab("safety")}>산업재해 확인 우선순위</button></div>
      {data ? <div className="ml-dashboard-notice"><strong>{data.tab === "wage" ? `기준월 ${data.data_as_of ?? "미확정"} · 예측 대상 ${data.target_label ?? "미확정"}` : `관측 기준 ${data.data_as_of ?? "미확정"} · 대상 기간 ${data.target_label ?? "미확정"}`}</strong><span>{data.basis_notice}</span>{data.stale_notice ? <span>{data.stale_notice}</span> : null}</div> : null}
      <div className="ml-dashboard-filters"><label>지역<select value={region} onChange={(event) => changeFilter("region", event.target.value)}><option value="">전체 지역</option>{data?.options.regions.map((option) => <option value={option} key={option}>{option}</option>)}</select></label><label>업종<select value={industry} onChange={(event) => changeFilter("industry", event.target.value)}><option value="">전체 업종</option>{data?.options.industries.map((option) => <option value={option} key={option}>{option}</option>)}</select></label></div>
      {loading ? <div className="batch-state-card">집계 데이터를 불러오는 중입니다.</div> : null}
      {error ? <div className="batch-state-card batch-state-error" role="alert"><strong>대시보드를 불러오지 못했습니다.</strong><span>{error}</span></div> : null}
      {data && !loading ? <section className="ml-distribution-panel" aria-label="지역·업종별 분포"><div className="ml-distribution-summary"><strong>{data.denominator.toLocaleString("ko-KR")}곳</strong><span>현재 필터의 집계 대상</span></div><div className="ml-distribution-list">{data.rows.map((row) => <article className="ml-distribution-card" key={`${row.region}-${row.industry}`}><header><div><strong>{row.industry}</strong><span>{row.region}</span></div><b>{row.firm_count.toLocaleString("ko-KR")}곳</b></header><div className="ml-category-grid">{row.categories.map((category) => <div key={category.key}><span>{category.label}</span><strong>{percent(category.ratio)}</strong><small>{category.count.toLocaleString("ko-KR")}곳</small><i><em style={{ width: `${category.ratio ?? 0}%` }} /></i></div>)}</div></article>)}</div>{data.rows.length === 0 ? <div className="batch-state-card">30곳 이상인 집계 셀이 없습니다.</div> : null}</section> : null}
    </main>
  );
}
