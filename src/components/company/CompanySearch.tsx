"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { CompanySearchResultCard } from "@/components/company/CompanySearchResultCard";
import type { CompanySearchResponse } from "@/domain/company";
import { readApiResponse } from "@/utils/clientApi";

const DEMO_QUERIES = ["OO건설", "한빛", "없는회사", "오류확인사업장", "error"] as const;

export function CompanySearch() {
  const router = useRouter();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CompanySearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(nextQuery: string) {
    const trimmed = nextQuery.trim();
    if (trimmed.length < 1) {
      setValidation("사업장명을 한 글자 이상 입력해 주세요.");
      setResult(null);
      return;
    }
    setValidation(null);
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(`/api/companies/search?q=${encodeURIComponent(trimmed)}`);
      setResult(await readApiResponse<CompanySearchResponse>(response));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "검색 결과를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search(query);
  }

  function applyDemoQuery(value: string) {
    setQuery(value);
    void search(value);
  }

  return (
    <div className="search-workspace">
      <form className="search-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor={inputId}>회사명 또는 사업장명</label>
        <div className="search-input-row">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="예: OO건설, 한빛테크"
            aria-describedby={validation ? `${inputId}-error` : `${inputId}-help`}
            aria-invalid={Boolean(validation)}
            autoComplete="off"
          />
          <button type="submit" className="button button-dark" disabled={loading}>
            {loading ? "검색 중" : "검색"}
          </button>
        </div>
        {validation ? (
          <p className="field-error" id={`${inputId}-error`} role="alert">
            {validation}
          </p>
        ) : (
          <p className="field-help" id={`${inputId}-help`}>
            이름이 같은 사업장이 있을 수 있으니 주소와 업종을 꼭 확인하세요.
          </p>
        )}
      </form>

      <div className="demo-query-row" aria-label="시연용 검색어">
        <span>시연 검색어</span>
        {DEMO_QUERIES.map((value) => (
          <button key={value} type="button" onClick={() => applyDemoQuery(value)} disabled={loading}>
            {value}
          </button>
        ))}
      </div>

      <section className="search-results" aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label="사업장 후보를 찾고 있습니다." /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={() => void search(query)} /> : null}
        {!loading && !error && result?.items.length === 0 ? (
          <EmptyState
            title="검색 결과가 없습니다"
            description="법인명이나 사업장명의 띄어쓰기를 바꾸거나 주소 단서를 함께 확인해 보세요."
          />
        ) : null}
        {!loading && !error && result && result.items.length > 0 ? (
          <>
            <div className="result-summary">
              <div>
                <span className="eyebrow">검색 결과</span>
                <h2>
                  ‘{result.query}’ 관련 사업장 <strong>{result.total}</strong>곳
                </h2>
              </div>
              <p>첫 번째 결과가 자동 선택되지 않습니다.</p>
            </div>
            <div className="company-result-list">
              {result.items.map((company) => (
                <CompanySearchResultCard
                  key={company.company_id}
                  company={company}
                  onSelect={(companyId) => router.push(`/companies/${encodeURIComponent(companyId)}`)}
                />
              ))}
            </div>
          </>
        ) : null}
        {!loading && !error && result === null ? (
          <div className="search-placeholder">
            <div aria-hidden="true" className="search-placeholder-icon">
              ⌕
            </div>
            <h2>확인할 사업장을 검색해 보세요</h2>
            <p>Mock 데이터에서는 ‘OO건설’을 검색하면 동명이인 선택 흐름을 확인할 수 있습니다.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
