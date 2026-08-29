"use client";

import { useEffect, useMemo, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type CommunityCategory,
  type CommunityCompanyContextDto,
  type CommunityPostDto,
} from "@/app/api/community/communityApiContract";
import { ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { listCommunityPosts } from "@/services/communityClient";

type CategoryFilter = CommunityCategory | "all";

const CATEGORY_FILTERS: CategoryFilter[] = ["all", ...COMMUNITY_CATEGORIES];

function categoryFilterLabel(filter: CategoryFilter): string {
  return filter === "all" ? "전체" : COMMUNITY_CATEGORY_LABELS[filter];
}

function companyContextLabel(context: CommunityCompanyContextDto | null): string {
  if (!context) return "연결 사업장 없음";
  return `${context.region ?? "지역 미확인"} · ${context.industry ?? "업종 미확인"}`;
}

function relativeTimeLabel(createdAt: string): string {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return "작성 시각 미확인";
  const minutes = Math.floor((Date.now() - createdMs) / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return createdAt.slice(0, 10);
}

export function CommunityBoard() {
  const [posts, setPosts] = useState<CommunityPostDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");

  function retry() {
    setLoading(true);
    setError(null);
    setReloadToken((current) => current + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    listCommunityPosts({}, { signal: controller.signal })
      .then((response) => setPosts(response.items))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setPosts([]);
        setError(caught instanceof Error ? caught.message : "커뮤니티 게시물을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("ko-KR");
    return posts.filter((post) => {
      if (category !== "all" && post.category !== category) return false;
      if (!term) return true;
      const context = `${post.title} ${post.body} ${companyContextLabel(post.company_context)}`;
      return context.toLocaleLowerCase("ko-KR").includes(term);
    });
  }, [posts, category, query]);

  return (
    <>
      <div className="community-interaction-row">
        <div className="community-toolbar" aria-label="커뮤니티 분류">
          {CATEGORY_FILTERS.map((item) => (
            <button key={item} className={category === item ? "is-active" : ""} type="button" onClick={() => setCategory(item)}>
              {categoryFilterLabel(item)}
            </button>
          ))}
        </div>
        <label className="community-search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="게시글 검색" /></label>
      </div>
      <section className="community-post-list" aria-label="커뮤니티 게시물" aria-live="polite" aria-busy={loading}>
        {loading ? <LoadingSkeleton label="커뮤니티 게시물을 불러오고 있습니다." /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={retry} /> : null}
        {!loading && !error
          ? filtered.map((post) => (
            <article className="community-post-card" key={post.post_id}>
              <div>
                <span>{post.category_label}</span>
                <small>{companyContextLabel(post.company_context)} · {post.author_label ?? "익명"} · {relativeTimeLabel(post.created_at)}</small>
              </div>
              <h2>{post.title}</h2><p>{post.body}</p>
              <strong>{post.like_count === null ? null : `공감 ${post.like_count}　`}댓글 {post.comment_count}</strong>
            </article>
          ))
          : null}
        {!loading && !error && filtered.length === 0 ? <div className="community-empty">조건에 맞는 게시물이 없습니다.</div> : null}
      </section>
    </>
  );
}
