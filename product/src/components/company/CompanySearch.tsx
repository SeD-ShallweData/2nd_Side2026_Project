"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { CompanySearchResultCard } from "@/components/company/CompanySearchResultCard";
import { RegionMap } from "@/components/company/RegionMap";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import type { SessionResponse } from "@/app/api/auth/authApiContract";
import type {
  CompanyFilterOptions,
  CompanySearchFilters,
  CompanySearchResponse,
} from "@/domain/company";
import { getSession } from "@/services/authClient";
import { getFavorites } from "@/services/favoriteClient";
import { readApiResponse } from "@/utils/clientApi";
import { publicClientHeaders } from "@/utils/publicClientId";

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
  const [session, setSession] = useState<SessionResponse | "loading">("loading");
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  // 지도를 첫 화면에 띄우려면 지역별 사업장 수가 먼저 있어야 한다. 필터 패널을
  // 열 때까지 기다리지 않고 들어오자마자 한 번 불러온다.
  useEffect(() => {
    void loadFilterOptions();
    // 화면에 처음 들어올 때 한 번이면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 즐겨찾기 선택 상태는 화면 진입 시 한 번만 조회해 로컬 Set으로 들고 있는다.
  // 로그인하지 않았거나 일반 사용자가 아니면 어차피 401/403이 나므로 조회를 건너뛴다.
  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((sessionResult) => {
        if (ignore) return;
        setSession(sessionResult);
        if (sessionResult.authenticated && sessionResult.user.role === "user") {
          return getFavorites({ signal: controller.signal }).then((favorites) => {
            if (!ignore) setFavoriteIds(new Set(favorites.items.map((item) => item.company_id)));
          });
        }
        return undefined;
      })
      .catch((error: unknown) => {
        if (ignore || (error instanceof DOMException && error.name === "AbortError")) return;
        setSession({ authenticated: false, user: null, expires_at: null });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  const favoriteEligibility = getFavoriteEligibility(session);

  function handleFavoriteChange(companyId: string, isFavorite: boolean) {
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (isFavorite) next.add(companyId);
      else next.delete(companyId);
      return next;
    });
  }

  async function search(nextQuery: string, page = 1, nextFilters = appliedFilters) {
    const trimmed = nextQuery.trim();
    const hasFilter = Boolean(nextFilters.region || nextFilters.industry);
    if (trimmed.length < 1 && !hasFilter) {
      setValidation("사업장명을 한 글자 이상 입력하거나 지도에서 지역을 골라 주세요.");
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
      const response = await fetch(`/api/companies/search?${searchParams.toString()}`, { headers: publicClientHeaders() });
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

  function selectRegionFromMap(region: string) {
    const nextFilters: CompanySearchFilters = { ...appliedFilters, region };
    setDraftFilters(nextFilters);
    setFiltersOpen(false);
    void search(query, 1, nextFilters);
  }

  function applyRecommendedQuery(value: string) {
    setQuery(value);
    void search(value, 1, appliedFilters);
  }

  async function loadFilterOptions() {
    setFilterOptionsLoading(true);
    setFilterOptionsError(null);
    try {
      const response = await fetch("/api/companies/filters", { headers: publicClientHeaders() });
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
          {/* 돋보기를 입력칸 위에 겹쳐 놓으면 글자와 부딪힌다. 테두리를 감싸는
              상자에 돋보기와 입력칸을 나란히 두고, 입력칸 자체는 테두리를 없앤다. */}
          <div className="search-input-field">
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
          </div>
          <div className="search-action-stack">
            <button
              type="button"
              className="search-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls={`${inputId}-filters`}
              onClick={toggleFilters}
            >
              필터{appliedFilters.region || appliedFilters.industry ? ` (${Number(Boolean(appliedFilters.region)) + Number(Boolean(appliedFilters.industry))})` : ""}
              <span className="filter-toggle-caret" aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
            </button>
            <button type="submit" className="button button-dark" disabled={loading}>
              {loading ? "검색 중" : "검색"}
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
                        {option.value} ({option.count_label})
                      </option>
                    ))}
                  </select>
                  {filterOptions.regions.length === 0 ? (
                    <small className="filter-state">등록된 지역 정보가 없어 지역 필터를 적용할 수 없습니다.</small>
                  ) : null}
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
                        {option.value} ({option.count_label})
                      </option>
                    ))}
                  </select>
                  {filterOptions.industries.length === 0 ? (
                    <small className="filter-state">등록된 업종 정보가 없어 업종 필터를 적용할 수 없습니다.</small>
                  ) : null}
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
                  {result.query
                    ? `‘${result.query}’ 관련 사업장 `
                    : `${[appliedFilters.region, appliedFilters.industry].filter(Boolean).join(" · ")} 사업장 `}
                  <strong>{result.total.toLocaleString("ko-KR")}{result.total_is_capped ? "+" : ""}</strong>곳
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
                  query={result.query}
                  onSelect={(companyId) => router.push(`/companies/${encodeURIComponent(companyId)}`)}
                  isFavorite={favoriteIds.has(company.company_id)}
                  favoriteEligibility={favoriteEligibility}
                  onFavoriteChange={handleFavoriteChange}
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
            <h2>어느 지역부터 볼까요?</h2>
            <p>지도에서 지역을 고르면 그 지역의 사업장을 바로 보여드립니다.
            <br />
            회사명을 알고 있다면 위에서 바로 검색하세요.</p>
            {filterOptionsError ? (
              <p className="field-error" role="alert">{filterOptionsError}</p>
            ) : filterOptions ? (
              <RegionMap
                counts={filterOptions.regions}
                selected={appliedFilters.region}
                onSelect={selectRegionFromMap}
                disabled={loading}
              />
            ) : (
              <p className="muted-text">지역별 사업장 수를 불러오는 중입니다.</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
