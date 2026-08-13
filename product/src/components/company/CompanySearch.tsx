"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { CompanySearchResultCard } from "@/components/company/CompanySearchResultCard";
import type {
  CompanyFilterOptions,
  CompanySearchFilters,
  CompanySearchResponse,
} from "@/domain/company";
import { readApiResponse } from "@/utils/clientApi";

const RECOMMENDED_QUERIES = ["건설", "한빛", "테크"] as const;
const EMPTY_FILTERS: CompanySearchFilters = {};

export function CompanySearch() {
  const router = useRouter();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CompanySearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterOptions, setFilterOptions] = useState<CompanyFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [filterOptionsError, setFilterOptionsError] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<CompanySearchFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<CompanySearchFilters>(EMPTY_FILTERS);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [pageValidation, setPageValidation] = useState<string | null>(null);

  async function search(nextQuery: string, page = 1, nextFilters = appliedFilters) {
    const trimmed = nextQuery.trim();
    if (trimmed.length < 1) {
      setValidation("사업장명을 한 글자 이상 입력해 주세요.");
      setResult(null);
      return;
    }
    setValidation(null);
    setError(null);
    setPageValidation(null);
    setLoading(true);
    try {
      const searchParams = new URLSearchParams({ q: trimmed, limit: "10", page: String(page) });
      if (nextFilters.region) searchParams.set("region", nextFilters.region);
      if (nextFilters.industry) searchParams.set("industry", nextFilters.industry);
      const response = await fetch(`/api/companies/search?${searchParams.toString()}`);
      setResult(await readApiResponse<CompanySearchResponse>(response));
      setAppliedFilters(nextFilters);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "검색 결과를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search(query, 1, draftFilters);
  }

  function applyRecommendedQuery(value: string) {
    setQuery(value);
    void search(value, 1, appliedFilters);
  }

  async function loadFilterOptions() {
    setFilterOptionsLoading(true);
    setFilterOptionsError(null);
    try {
      const response = await fetch("/api/companies/filters");
      setFilterOptions(await readApiResponse<CompanyFilterOptions>(response));
    } catch (caught) {
      setFilterOptionsError(caught instanceof Error ? caught.message : "필터 목록을 불러오지 못했습니다.");
    } finally {
      setFilterOptionsLoading(false);
    }
  }

  function toggleFilters() {
    const nextOpen = !filtersOpen;
    setFiltersOpen(nextOpen);
    if (nextOpen && !filterOptions && !filterOptionsLoading) void loadFilterOptions();
  }

  function applyFilters() {
    if (!query.trim()) {
      setValidation("필터를 적용할 사업장명을 먼저 입력해 주세요.");
      return;
    }
    setFiltersOpen(false);
    void search(query, 1, draftFilters);
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    if (result) void search(result.query, 1, EMPTY_FILTERS);
    else setAppliedFilters(EMPTY_FILTERS);
  }

  function startEditingPage() {
    if (!result) return;
    setPageDraft(String(result.page));
    setPageValidation(null);
    setEditingPage(true);
  }

  function goToDraftPage() {
    if (!result) return;
    const nextPage = Number(pageDraft);
    if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > result.total_pages) {
      setPageValidation(`1부터 ${result.total_pages.toLocaleString("ko-KR")} 사이의 페이지를 입력해 주세요.`);
      return;
    }
    setEditingPage(false);
    if (nextPage !== result.page) void search(result.query, nextPage, appliedFilters);
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
            placeholder="예: 건설, 한빛테크"
            aria-describedby={validation ? `${inputId}-error` : `${inputId}-help`}
            aria-invalid={Boolean(validation)}
            autoComplete="off"
          />
          <div className="search-action-stack">
            <button type="submit" className="button button-dark" disabled={loading}>
              {loading ? "검색 중" : "검색"}
            </button>
            <button
              type="button"
              className="search-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls={`${inputId}-filters`}
              onClick={toggleFilters}
            >
              <span aria-hidden="true">☷</span>
              필터{appliedFilters.region || appliedFilters.industry ? ` (${Number(Boolean(appliedFilters.region)) + Number(Boolean(appliedFilters.industry))})` : ""}
              <span className="filter-toggle-caret" aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
            </button>
          </div>
        </div>
        {filtersOpen ? (
          <div className="search-filter-panel" id={`${inputId}-filters`}>
            <div className="filter-panel-heading">
              <div>
                <strong>검색 결과 필터</strong>
                <span>지역과 업종을 선택하면 결과 수와 페이지가 다시 계산됩니다.</span>
              </div>
              {draftFilters.region || draftFilters.industry ? (
                <button type="button" className="filter-reset" onClick={clearFilters}>전체 해제</button>
              ) : null}
            </div>
            {filterOptionsLoading ? <p className="filter-state" role="status">지역·업종 목록을 불러오는 중입니다.</p> : null}
            {!filterOptionsLoading && filterOptionsError ? (
              <div className="filter-state filter-state-error" role="alert">
                <span>{filterOptionsError}</span>
                <button type="button" onClick={() => void loadFilterOptions()}>다시 시도</button>
              </div>
            ) : null}
            {filterOptions ? (
              <div className="filter-controls">
                <label>
                  <span>지역</span>
                  <select
                    value={draftFilters.region ?? ""}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, region: event.target.value || undefined }))}
                  >
                    <option value="">전체 지역</option>
                    {filterOptions.regions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count.toLocaleString("ko-KR")})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>업종</span>
                  <select
                    value={draftFilters.industry ?? ""}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, industry: event.target.value || undefined }))}
                  >
                    <option value="">전체 업종</option>
                    {filterOptions.industries.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count.toLocaleString("ko-KR")})
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="button button-dark filter-apply" disabled={loading} onClick={applyFilters}>
                  필터 적용
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {validation ? (
          <p className="field-error" id={`${inputId}-error`} role="alert">
            {validation}
          </p>
        ) : (
          <p className="field-help" id={`${inputId}-help`}>
            이름이 같은 사업장이 있을 수 있으니 지역과 업종을 꼭 확인하세요.
          </p>
        )}
      </form>

      <div className="demo-query-row" aria-label="추천 검색어">
        <span>추천 검색어</span>
        {RECOMMENDED_QUERIES.map((value) => (
          <button key={value} type="button" onClick={() => applyRecommendedQuery(value)} disabled={loading}>
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
            description="법인명이나 사업장명의 띄어쓰기를 바꾸고, 검색된 지역·업종 단서를 함께 확인해 보세요."
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
            {appliedFilters.region || appliedFilters.industry ? (
              <div className="applied-filter-row" aria-label="적용 중인 필터">
                <span>적용 필터</span>
                {appliedFilters.region ? <strong>지역 · {appliedFilters.region}</strong> : null}
                {appliedFilters.industry ? <strong>업종 · {appliedFilters.industry}</strong> : null}
                <button type="button" onClick={clearFilters}>전체 해제</button>
              </div>
            ) : null}
            <div className="company-result-list">
              {result.items.map((company) => (
                <CompanySearchResultCard
                  key={company.company_id}
                  company={company}
                  onSelect={(companyId) => router.push(`/companies/${encodeURIComponent(companyId)}`)}
                />
              ))}
            </div>
            {result.total_pages > 1 ? (
              <nav className="search-pagination" aria-label="사업장 검색 결과 페이지">
                <button
                  type="button"
                  className="button button-outline"
                  disabled={loading || result.page <= 1}
                  onClick={() => void search(result.query, result.page - 1)}
                >
                  ← 이전
                </button>
                <span className="pagination-page">
                  {editingPage ? (
                    <input
                      autoFocus
                      type="number"
                      min="1"
                      max={result.total_pages}
                      step="1"
                      value={pageDraft}
                      aria-label={`이동할 페이지, 전체 ${result.total_pages}페이지`}
                      onChange={(event) => setPageDraft(event.target.value)}
                      onBlur={goToDraftPage}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          goToDraftPage();
                        }
                        if (event.key === "Escape") {
                          setEditingPage(false);
                          setPageValidation(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="pagination-current-page"
                      aria-label={`현재 ${result.page}페이지. 클릭하여 이동할 페이지 입력`}
                      onClick={startEditingPage}
                    >
                      {result.page}
                    </button>
                  )}
                  <span>/ {result.total_pages.toLocaleString("ko-KR")} 페이지</span>
                </span>
                <button
                  type="button"
                  className="button button-outline"
                  disabled={loading || !result.has_more}
                  onClick={() => void search(result.query, result.page + 1)}
                >
                  다음 →
                </button>
              </nav>
            ) : null}
            {pageValidation ? <p className="pagination-error" role="alert">{pageValidation}</p> : null}
          </>
        ) : null}
        {!loading && !error && result === null ? (
          <div className="search-placeholder">
            <div aria-hidden="true" className="search-placeholder-icon">
              ⌕
            </div>
            <h2>확인할 사업장을 검색해 보세요</h2>
            <p>회사명이 같을 수 있으므로 지역과 업종을 함께 확인해 정확한 사업장을 선택하세요.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
