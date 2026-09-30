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
import { format } from "@/i18n/defineMessages";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { companyMessages } from "@/i18n/messages/company";

// 추천 검색어는 한국어 사업장명에서 찾는 값이라 번역하지 않는다.
const RECOMMENDED_QUERIES = ["건설", "한빛", "테크"] as const;
const EMPTY_FILTERS: CompanySearchFilters = {};

export function CompanySearch() {
  const router = useRouter();
  const cm = useMessages(companyMessages);
  const m = cm.search;
  const locale = useLocale();
  // 다른 언어는 지역 이름 표시만 번역한다. 선택값(검색 API 로 가는 값)은 항상 한국어 공식 명칭이다.
  const regionLabel = (value: string): string =>
    locale === "ko" || locale === "ko-easy" ? value : cm.regions[value as keyof typeof cm.regions]?.name ?? value;
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
      setValidation(m.validationEmpty);
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
      setError(caught instanceof Error ? caught.message : m.loadFailed);
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
      setFilterOptionsError(caught instanceof Error ? caught.message : m.filterLoadFailed);
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
    // 지도에서 지역만 고른 뒤 업종을 더하는 흐름이 있어 사업장명 없이도 적용한다.
    // 사업장명도 필터도 없으면 search() 가 안내 문구를 띄운다.
    if (!query.trim() && !draftFilters.region && !draftFilters.industry) {
      setValidation(m.validationFilters);
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
      setPageValidation(format(m.pageRange, { max: result.total_pages.toLocaleString("ko-KR") }));
      return;
    }
    setEditingPage(false);
    if (nextPage !== result.page) void search(result.query, nextPage, appliedFilters);
  }

  return (
    <div className="search-workspace">
      <form className="search-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor={inputId}>{m.label}</label>
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
              placeholder={m.placeholder}
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
              {appliedFilters.region || appliedFilters.industry
                ? format(m.filterWithCount, { count: Number(Boolean(appliedFilters.region)) + Number(Boolean(appliedFilters.industry)) })
                : m.filter}
              <span className="filter-toggle-caret" aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
            </button>
            <button type="submit" className="button button-dark" disabled={loading}>
              {loading ? m.searching : m.submit}
            </button>
          </div>
        </div>
        {filtersOpen ? (
          <div className="search-filter-panel" id={`${inputId}-filters`}>
            <div className="filter-panel-heading">
              <div>
                <strong>{m.filterPanelTitle}</strong>
                <span>{m.filterPanelHint}</span>
              </div>
              {draftFilters.region || draftFilters.industry ? (
                <button type="button" className="filter-reset" onClick={clearFilters}>{m.clearAll}</button>
              ) : null}
            </div>
            {filterOptionsLoading ? <p className="filter-state" role="status">{m.filterLoading}</p> : null}
            {!filterOptionsLoading && filterOptionsError ? (
              <div className="filter-state filter-state-error" role="alert">
                <span>{filterOptionsError}</span>
                <button type="button" onClick={() => void loadFilterOptions()}>{m.retry}</button>
              </div>
            ) : null}
            {filterOptions ? (
              <div className="filter-controls">
                <label>
                  <span>{m.region}</span>
                  <select
                    value={draftFilters.region ?? ""}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, region: event.target.value || undefined }))}
                  >
                    <option value="">{m.allRegions}</option>
                    {filterOptions.regions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {regionLabel(option.value)} ({option.count.toLocaleString("ko-KR")})
                      </option>
                    ))}
                  </select>
                  {filterOptions.regions.length === 0 ? (
                    <small className="filter-state">{m.noRegions}</small>
                  ) : null}
                </label>
                <label>
                  <span>{m.industry}</span>
                  <select
                    value={draftFilters.industry ?? ""}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, industry: event.target.value || undefined }))}
                  >
                    <option value="">{m.allIndustries}</option>
                    {filterOptions.industries.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count.toLocaleString("ko-KR")})
                      </option>
                    ))}
                  </select>
                  {filterOptions.industries.length === 0 ? (
                    <small className="filter-state">{m.noIndustries}</small>
                  ) : null}
                </label>
                <button type="button" className="button button-dark filter-apply" disabled={loading} onClick={applyFilters}>
                  {m.applyFilters}
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
            {m.help}
          </p>
        )}
      </form>

      <div className="demo-query-row" aria-label={m.recommended}>
        <span>{m.recommended}</span>
        {RECOMMENDED_QUERIES.map((value) => (
          <button key={value} type="button" onClick={() => applyRecommendedQuery(value)} disabled={loading}>
            {value}
          </button>
        ))}
      </div>

      <section className="search-results" aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label={m.loading} /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={() => void search(query)} /> : null}
        {!loading && !error && result?.items.length === 0 ? (
          <EmptyState
            title={m.emptyTitle}
            description={m.emptyDescription}
          />
        ) : null}
        {!loading && !error && result && result.items.length > 0 ? (
          <>
            <div className="result-summary">
              <div>
                <span className="eyebrow">{m.resultsEyebrow}</span>
                <h2>
                  {result.query
                    ? format(m.resultsForQuery, { query: result.query })
                    : format(m.resultsForFilters, {
                        filters: [appliedFilters.region, appliedFilters.industry].filter(Boolean).join(" · "),
                      })}
                  <strong>{result.total.toLocaleString("ko-KR")}</strong>{m.resultsCountSuffix}
                </h2>
              </div>
              <p>{m.noAutoSelect}</p>
            </div>
            {appliedFilters.region || appliedFilters.industry ? (
              <div className="applied-filter-row" aria-label={m.appliedAria}>
                <span>{m.appliedLabel}</span>
                {appliedFilters.region ? <strong>{format(m.appliedRegion, { value: appliedFilters.region })}</strong> : null}
                {appliedFilters.industry ? <strong>{format(m.appliedIndustry, { value: appliedFilters.industry })}</strong> : null}
                <button type="button" onClick={clearFilters}>{m.clearAll}</button>
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
              <nav className="search-pagination" aria-label={m.paginationAria}>
                <button
                  type="button"
                  className="button button-outline"
                  disabled={loading || result.page <= 1}
                  onClick={() => void search(result.query, result.page - 1)}
                >
                  {m.prev}
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
                      aria-label={format(m.pageInputAria, { total: result.total_pages })}
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
                      aria-label={format(m.currentPageAria, { page: result.page })}
                      onClick={startEditingPage}
                    >
                      {result.page}
                    </button>
                  )}
                  <span>{format(m.pageTotal, { total: result.total_pages.toLocaleString("ko-KR") })}</span>
                </span>
                <button
                  type="button"
                  className="button button-outline"
                  disabled={loading || !result.has_more}
                  onClick={() => void search(result.query, result.page + 1)}
                >
                  {m.next}
                </button>
              </nav>
            ) : null}
            {pageValidation ? <p className="pagination-error" role="alert">{pageValidation}</p> : null}
          </>
        ) : null}
        {!loading && !error && result === null ? (
          <div className="search-placeholder">
            <h2>{m.mapHeading}</h2>
            <p>{m.mapIntro1}<br />{m.mapIntro2}</p>
            {filterOptionsError ? (
              <p className="field-error" role="alert">{filterOptionsError}</p>
            ) : filterOptions ? (
              <RegionMap
                counts={filterOptions.regions}
                total={filterOptions.total}
                selected={appliedFilters.region}
                onSelect={selectRegionFromMap}
                disabled={loading}
              />
            ) : (
              <p className="muted-text">{m.mapLoading}</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
