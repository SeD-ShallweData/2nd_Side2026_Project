"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  type CommunityCategory,
  type CommunityPostListResponse,
} from "@/app/api/community/communityApiContract";
import { ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { companyContextLabel, relativeTimeLabel } from "@/components/community/communityFormat";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
import { listCommunityPosts } from "@/services/communityClient";

type CategoryFilter = CommunityCategory | "all";

interface LoadedList {
  key: string;
  result: CommunityPostListResponse | null;
  error: string | null;
}

const CATEGORY_FILTERS: CategoryFilter[] = ["all", ...COMMUNITY_CATEGORIES];
const SEARCH_DEBOUNCE_MS = 300;

export function CommunityBoard() {
  const m = useMessages(communityMessages);
  const n = (value: number) => value.toLocaleString(m.numberLocale);
  const loadFailedMessage = m.board.loadFailed;
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedList | null>(null);

  const requestKey = `${reloadToken}|${category}|${page}|${searchTerm}`;
  // 요청 조건이 바뀌면 아직 도착하지 않은 결과이므로 로딩으로 본다.
  const loading = loaded?.key !== requestKey;
  const result = loading ? null : loaded?.result ?? null;
  const error = loading ? null : loaded?.error ?? null;

  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    listCommunityPosts(
      {
        q: searchTerm || undefined,
        category: category === "all" ? null : category,
        page,
      },
      { signal: controller.signal },
    )
      .then((response) => setLoaded({ key: requestKey, result: response, error: null }))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoaded({
          key: requestKey,
          result: null,
          error: caught instanceof Error ? caught.message : loadFailedMessage,
        });
      });
    return () => controller.abort();
  }, [requestKey, searchTerm, category, page, loadFailedMessage]);

  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  function changeCategory(next: CategoryFilter) {
    setCategory(next);
    setPage(1);
  }

  return (
    <>
      <div className="community-interaction-row">
        <div className="community-toolbar" aria-label={m.board.categoryAria}>
          {CATEGORY_FILTERS.map((item) => (
            <button key={item} className={category === item ? "is-active" : ""} type="button" onClick={() => changeCategory(item)}>
              {item === "all" ? m.categoryAll : m.categories[item]}
            </button>
          ))}
        </div>
        <div className="community-search-actions">
          <label className="community-search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder={m.board.searchPlaceholder} aria-label={m.board.searchAria} /></label>
          {result?.capabilities.write ? <Link href="/community/new" className="button button-dark">{m.board.write}</Link> : null}
        </div>
      </div>
      <section className="community-post-list" aria-label={m.board.listAria} aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label={m.board.loading} /> : null}
        {error ? <ErrorState message={error} onRetry={() => setReloadToken((current) => current + 1)} /> : null}
        {result && result.total > 0 ? (
          <p className="field-help">
            {format(m.board.summary, {
              total: n(result.total),
              page: n(result.page),
              totalPages: n(result.total_pages),
              pageSize: n(result.page_size),
            })}
          </p>
        ) : null}
        {result?.items.map((post) => (
          <article className="community-post-card" key={post.post_id}>
            <div>
              <span>{m.categories[post.category] ?? post.category_label}</span>
              <small>
                {[companyContextLabel(post.company_context, m.format), post.author_label ?? m.post.anonymous, relativeTimeLabel(post.created_at, m.format)]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ")}
              </small>
            </div>
            <h2><Link href={`/community/${encodeURIComponent(post.post_id)}`}>{post.title}</Link></h2><p>{post.body}</p>
            <strong>{post.like_count === null ? null : `${format(m.post.likes, { count: post.like_count })}　`}{format(m.post.comments, { count: post.comment_count })}</strong>
          </article>
        ))}
        {result && result.items.length === 0 ? <div className="community-empty">{m.board.empty}</div> : null}
        {result && result.total_pages > 1 ? (
          <nav className="search-pagination" aria-label={m.board.paginationAria}>
            <button type="button" className="button button-outline" disabled={result.page <= 1} onClick={() => setPage(result.page - 1)}>
              {m.board.prev}
            </button>
            <span className="pagination-page">
              <span>{n(result.page)}</span>
              <span>{format(m.board.pageTotal, { total: n(result.total_pages) })}</span>
            </span>
            <button type="button" className="button button-outline" disabled={!result.has_more} onClick={() => setPage(result.page + 1)}>
              {m.board.next}
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}
