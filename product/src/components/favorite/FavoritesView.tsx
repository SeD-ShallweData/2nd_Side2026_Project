"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { getFavoriteEligibility } from "@/components/favorite/favoriteAuth";
import { describeFavoriteError } from "@/components/favorite/favoriteErrorMessage";
import { readFavoriteOrder, reconcileFavoriteOrder, reorderVisibleFavorites, saveFavoriteOrder } from "@/components/favorite/favoriteOrder";
import type { FavoriteCompanyDto } from "@/app/api/users/me/favorites/favoriteApiContract";
import { getSession } from "@/services/authClient";
import { getFavorites, removeFavorite } from "@/services/favoriteClient";
import { useLocale, useMessages } from "@/i18n/LocaleProvider";
import { htmlLang, type Locale } from "@/i18n/locales";
import { favoriteMessages } from "@/i18n/messages/favorite";
import { companyMessages } from "@/i18n/messages/company";
import { format } from "@/i18n/defineMessages";

type ViewState =
  | { status: "loading" }
  | { status: "login-required" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; userId: string; items: FavoriteCompanyDto[]; orderedIds: string[] };

function formatDate(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(locale === "ko" || locale === "ko-easy" ? "ko-KR" : htmlLang(locale));
}

function optionsFor(items: FavoriteCompanyDto[], field: "region" | "industry") {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item[field]?.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b, "ko-KR"));
}

export function FavoritesView() {
  const locale = useLocale();
  const m = useMessages(favoriteMessages);
  const cm = useMessages(companyMessages);
  const regionLabel = (value: string): string =>
    locale === "ko" || locale === "ko-easy" ? value : cm.regions[value as keyof typeof cm.regions]?.name ?? value;
  const inputId = useId();
  const dragSource = useRef<string | null>(null);
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [orderSaveError, setOrderSaveError] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [region, setRegion] = useState("");
  const [industry, setIndustry] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    async function load() {
      try {
        const session = await getSession({ signal: controller.signal });
        if (ignore) return;
        const eligibility = getFavoriteEligibility(session);
        if (!eligibility.eligible) {
          setView({ status: eligibility.reason?.requiresLogin ? "login-required" : "forbidden" });
          return;
        }
        const result = await getFavorites({ signal: controller.signal });
        if (!ignore && session.authenticated) setView({
          status: "ready",
          userId: session.user.user_id,
          items: result.items,
          orderedIds: reconcileFavoriteOrder(result.items, readFavoriteOrder(session.user.user_id)),
        });
      } catch (caught) {
        if (ignore || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setView({ status: "error", message: describeFavoriteError(caught, m.errors) });
      }
    }

    void load();
    return () => {
      ignore = true;
      controller.abort();
    };
    // 쉬운 한국어 사전은 렌더마다 새 객체라 의존성에 넣지 않는다. bfcache 복원 때만 다시 조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => {
    const refreshAfterRestore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setView({ status: "loading" });
        setRemoveError(null);
        setReload((current) => current + 1);
      }
    };
    window.addEventListener("pageshow", refreshAfterRestore);
    return () => window.removeEventListener("pageshow", refreshAfterRestore);
  }, []);

  useEffect(() => {
    if (view.status !== "ready") return;
    setOrderSaveError(!saveFavoriteOrder(view.userId, view.orderedIds));
    const regions = new Set(optionsFor(view.items, "region").map(([value]) => value));
    const industries = new Set(optionsFor(view.items, "industry").map(([value]) => value));
    setRegion((current) => regions.has(current) ? current : "");
    setIndustry((current) => industries.has(current) ? current : "");
  }, [view]);

  async function handleRemove(companyId: string) {
    if (removingId || view.status !== "ready") return;
    const ownerId = view.userId;
    setRemoveError(null);
    setRemovingId(companyId);
    try {
      await removeFavorite(companyId);
      setView((current) => {
        if (current.status !== "ready" || current.userId !== ownerId) return current;
        const items = current.items.filter((item) => item.company_id !== companyId);
        return { ...current, items, orderedIds: reconcileFavoriteOrder(items, current.orderedIds) };
      });
    } catch (caught) {
      setRemoveError(describeFavoriteError(caught, m.errors));
    } finally {
      setRemovingId(null);
    }
  }

  if (view.status === "loading") {
    return <LoadingSkeleton label={m.view.loading} />;
  }

  if (view.status === "login-required") {
    return (
      <EmptyState
        title={m.view.loginTitle}
        description={m.view.loginDescription}
        action={
          <Link href="/login?next=%2Ffavorites" className="button button-dark">
            {m.view.loginButton}
          </Link>
        }
      />
    );
  }

  if (view.status === "forbidden") {
    return (
      <EmptyState
        title={m.view.forbiddenTitle}
        description={m.view.forbiddenDescription}
      />
    );
  }

  if (view.status === "error") {
    return <ErrorState message={view.message} onRetry={() => window.location.reload()} />;
  }

  const regionOptions = optionsFor(view.items, "region");
  const industryOptions = optionsFor(view.items, "industry");
  const byId = new Map(view.items.map((item) => [item.company_id, item]));
  const orderedItems = view.orderedIds.map((id) => byId.get(id)).filter((item): item is FavoriteCompanyDto => Boolean(item));
  const normalizedQuery = appliedQuery.toLocaleLowerCase();
  const visibleItems = orderedItems.filter((item) =>
    item.company_name.toLocaleLowerCase().includes(normalizedQuery)
    && (!region || item.region === region)
    && (!industry || item.industry === industry));
  const visibleIds = visibleItems.map((item) => item.company_id);

  function move(sourceId: string, targetId: string) {
    const ownerId = view.userId;
    setView((current) => current.status === "ready" && current.userId === ownerId
      ? { ...current, orderedIds: reorderVisibleFavorites(current.orderedIds, visibleIds, sourceId, targetId) }
      : current);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>, targetId: string) {
    event.preventDefault();
    if (dragSource.current) move(dragSource.current, targetId);
    dragSource.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }

  function handleMoveKey(event: KeyboardEvent<HTMLButtonElement>, companyId: string) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = visibleIds.indexOf(companyId);
    const targetId = visibleIds[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (targetId) move(companyId, targetId);
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedQuery(query.trim());
  }

  return (
    <div className="favorite-view">
      <form className="search-form favorite-search-form" onSubmit={applySearch}>
        <label htmlFor={inputId}>{m.view.searchLabel}</label>
        <div className="search-input-row">
          <div className="search-input-field">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input id={inputId} value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={m.view.searchPlaceholder} autoComplete="off" />
          </div>
          <div className="search-action-stack">
            <button type="button" className="search-filter-toggle" aria-expanded={filtersOpen}
              aria-controls={`${inputId}-filters`} onClick={() => setFiltersOpen((open) => !open)}>
              {region || industry ? format(m.view.filterWithCount, { count: Number(Boolean(region)) + Number(Boolean(industry)) }) : m.view.filter}
              <span className="filter-toggle-caret" aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
            </button>
            <button type="submit" className="button button-dark">{m.view.search}</button>
          </div>
        </div>
        {filtersOpen ? <div className="search-filter-panel" id={`${inputId}-filters`}>
          <div className="filter-panel-heading"><div><strong>{m.view.filterTitle}</strong><span>{m.view.filterHint}</span></div>
            {region || industry ? <button type="button" className="filter-reset" onClick={() => { setRegion(""); setIndustry(""); }}>{m.view.clearFilters}</button> : null}
          </div>
          <div className="filter-controls">
            <label><span>{m.view.region}</span><select value={region} onChange={(event) => setRegion(event.target.value)}>
              <option value="">{m.view.allRegions}</option>
              {regionOptions.map(([value, count]) => <option key={value} value={value}>{regionLabel(value)} ({count.toLocaleString(locale === "ko-easy" ? "ko-KR" : htmlLang(locale))})</option>)}
            </select></label>
            <label><span>{m.view.industry}</span><select value={industry} onChange={(event) => setIndustry(event.target.value)}>
              <option value="">{m.view.allIndustries}</option>
              {industryOptions.map(([value, count]) => <option key={value} value={value}>{value} ({count.toLocaleString(locale === "ko-easy" ? "ko-KR" : htmlLang(locale))})</option>)}
            </select></label>
            <button type="button" className="button button-dark filter-apply" onClick={() => setFiltersOpen(false)}>{m.view.applyFilters}</button>
          </div>
        </div> : null}
      </form>

      {orderSaveError ? <p className="field-error" role="alert">{m.view.orderSaveFailed}</p> : null}
      {removeError ? <p className="field-error" role="alert">{removeError}</p> : null}
      {view.items.length === 0 ? <EmptyState title={m.view.emptyTitle} description={m.view.emptyDescription}
        action={<Link href="/companies" className="button button-dark">{m.view.emptyButton}</Link>} /> :
        visibleItems.length === 0 ? <EmptyState title={m.view.noResultsTitle} description={m.view.noResultsDescription} /> : (
          <div className="company-result-list favorite-result-list">
            {visibleItems.map((item) => (
              <article key={item.company_id} className={`favorite-card${draggingId === item.company_id ? " is-dragging" : ""}${dragOverId === item.company_id ? " is-drag-over" : ""}`}>
                <button type="button" className="favorite-drag-handle" draggable={visibleItems.length > 1 && !removingId}
                  disabled={visibleItems.length < 2 || Boolean(removingId)}
                  aria-label={format(m.view.reorderAria, { name: item.company_name })}
                  aria-keyshortcuts="ArrowUp ArrowDown" title={m.view.reorderHint}
                  onKeyDown={(event) => handleMoveKey(event, item.company_id)}
                  onDragStart={(event) => { dragSource.current = item.company_id; setDraggingId(item.company_id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.company_id); }}
                  onDragOver={(event) => { if (dragSource.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverId(item.company_id); } }}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={(event) => handleDrop(event, item.company_id)}
                  onDragEnd={() => { dragSource.current = null; setDraggingId(null); setDragOverId(null); }}>
                  <span className="favorite-handle-icon" aria-hidden="true">★</span>
                  <span className="favorite-handle-arrows" aria-hidden="true">↑<br />↓</span>
                </button>
                <div className="favorite-card-main">
                  <h3>{item.company_name}</h3>
                  <dl className="company-meta-list">
                    <div><dt>{m.view.region}</dt><dd>{item.region ? regionLabel(item.region) : m.view.noInfo}</dd></div>
                    <div><dt>{m.view.industry}</dt><dd>{item.industry ?? m.view.noInfo}</dd></div>
                    <div><dt>{m.view.addedAt}</dt><dd>{formatDate(item.created_at, locale)}</dd></div>
                  </dl>
                </div>
                <div className="favorite-card-actions">
                  <Link href={`/companies/${encodeURIComponent(item.company_id)}`} className="button button-outline">{m.view.details}</Link>
                  <button type="button" className="button button-dark" disabled={Boolean(removingId)}
                    onClick={() => void handleRemove(item.company_id)}>
                    {removingId === item.company_id ? m.button.pending : m.button.remove}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
    </div>
  );
}
