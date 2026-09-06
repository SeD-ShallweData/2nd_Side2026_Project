"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type CommunityCategory,
  type CommunityPostListResponse,
} from "@/app/api/community/communityApiContract";
import { ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { companyContextLabel, relativeTimeLabel } from "@/components/community/communityFormat";
import { listCommunityPosts } from "@/services/communityClient";

type CategoryFilter = CommunityCategory | "all";

interface LoadedList {
  key: string;
  result: CommunityPostListResponse | null;
  error: string | null;
}

const CATEGORY_FILTERS: CategoryFilter[] = ["all", ...COMMUNITY_CATEGORIES];
const SEARCH_DEBOUNCE_MS = 300;

function categoryFilterLabel(filter: CategoryFilter): string {
  return filter === "all" ? "전체" : COMMUNITY_CATEGORY_LABELS[filter];
}

export function CommunityBoard() {
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
          error: caught instanceof Error ? caught.message : "커뮤니티 게시물을 불러오지 못했습니다.",
        });
      });
    return () => controller.abort();
  }, [requestKey, searchTerm, category, page]);

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
        <div className="community-toolbar" aria-label="커뮤니티 분류">
          {CATEGORY_FILTERS.map((item) => (
            <button key={item} className={category === item ? "is-active" : ""} type="button" onClick={() => changeCategory(item)}>
              {categoryFilterLabel(item)}
            </button>
          ))}
          {result?.capabilities.write ? <Link href="/community/new" className="button button-dark">글쓰기</Link> : null}
        </div>
        <label className="community-search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="게시글 검색" aria-label="게시글 검색" /></label>
      </div>
      <section className="community-post-list" aria-label="커뮤니티 게시물" aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label="커뮤니티 게시물을 불러오고 있습니다." /> : null}
        {error ? <ErrorState message={error} onRetry={() => setReloadToken((current) => current + 1)} /> : null}
        {result && result.total > 0 ? (
          <p className="field-help">
            전체 {result.total.toLocaleString("ko-KR")}건 · {result.page.toLocaleString("ko-KR")}/{result.total_pages.toLocaleString("ko-KR")} 페이지 · 한 페이지 {result.page_size.toLocaleString("ko-KR")}건
          </p>
        ) : null}
        {result?.items.map((post) => (
          <article className="community-post-card" key={post.post_id}>
            <div>
              <span>{post.category_label}</span>
              <small>{companyContextLabel(post.company_context)} · {post.author_label ?? "익명"} · {relativeTimeLabel(post.created_at)}</small>
            </div>
            <h2><Link href={`/community/${encodeURIComponent(post.post_id)}`}>{post.title}</Link></h2><p>{post.body}</p>
            <strong>{post.like_count === null ? null : `공감 ${post.like_count}　`}댓글 {post.comment_count}</strong>
          </article>
        ))}
        {result && result.items.length === 0 ? <div className="community-empty">조건에 맞는 게시물이 없습니다.</div> : null}
        {result && result.total_pages > 1 ? (
          <nav className="search-pagination" aria-label="커뮤니티 게시물 페이지">
            <button type="button" className="button button-outline" disabled={result.page <= 1} onClick={() => setPage(result.page - 1)}>
              ← 이전
            </button>
            <span className="pagination-page">
              <span>{result.page.toLocaleString("ko-KR")}</span>
              <span>/ {result.total_pages.toLocaleString("ko-KR")} 페이지</span>
            </span>
            <button type="button" className="button button-outline" disabled={!result.has_more} onClick={() => setPage(result.page + 1)}>
              다음 →
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}
