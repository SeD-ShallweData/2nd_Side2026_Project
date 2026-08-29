"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CommunityPostDto } from "@/app/api/community/communityApiContract";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { companyContextLabel, relativeTimeLabel } from "@/components/community/communityFormat";
import { CommunityReportForm } from "@/components/community/CommunityReportForm";
import { CommunityApiError, getCommunityPost } from "@/services/communityClient";

interface LoadedPost {
  key: string;
  post: CommunityPostDto | null;
  notFound: boolean;
  error: string | null;
}

export function CommunityPostDetail({ postId }: { postId: string }) {
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPost | null>(null);

  const requestKey = `${reloadToken}|${postId}`;
  const loading = loaded?.key !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    getCommunityPost(postId, { signal: controller.signal })
      .then((post) => setLoaded({ key: requestKey, post, notFound: false, error: null }))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        const notFound = caught instanceof CommunityApiError && caught.code === "COMMUNITY_POST_NOT_FOUND";
        setLoaded({
          key: requestKey,
          post: null,
          notFound,
          error: notFound ? null : caught instanceof Error ? caught.message : "게시글을 불러오지 못했습니다.",
        });
      });
    return () => controller.abort();
  }, [requestKey, postId]);

  const post = loading ? null : loaded?.post ?? null;

  return (
    <section aria-label="커뮤니티 게시글 상세" aria-live="polite" aria-busy={loading}>
      {loading ? <LoadingSkeleton label="게시글을 불러오고 있습니다." /> : null}
      {!loading && loaded?.notFound ? (
        <EmptyState
          title="게시글을 찾을 수 없습니다"
          description="삭제되었거나 공개되지 않은 게시글입니다. 커뮤니티 목록에서 다시 확인해 주세요."
          action={<Link href="/community" className="button button-dark">커뮤니티 목록으로</Link>}
        />
      ) : null}
      {!loading && loaded?.error ? (
        <ErrorState message={loaded.error} onRetry={() => setReloadToken((current) => current + 1)} />
      ) : null}
      {post ? (
        <>
          <article className="community-post-card">
            <div>
              <span>{post.category_label}</span>
              <small>
                {companyContextLabel(post.company_context)} · {post.author_label ?? "익명"} · {relativeTimeLabel(post.created_at)}
                {post.updated_at === post.created_at ? "" : ` · ${relativeTimeLabel(post.updated_at)} 수정됨`}
              </small>
            </div>
            <h2>{post.title}</h2><p>{post.body}</p>
            <strong>{post.like_count === null ? null : `공감 ${post.like_count}　`}댓글 {post.comment_count}</strong>
          </article>
          <p className="field-help">댓글과 공감은 아직 제공하지 않습니다. 위 숫자는 현재 표시용 값입니다.</p>
          {post.capabilities.reports && post.viewer_permissions.can_report ? (
            <CommunityReportForm key={post.post_id} postId={post.post_id} />
          ) : null}
          <Link href="/community" className="button button-outline">목록으로</Link>
        </>
      ) : null}
    </section>
  );
}
