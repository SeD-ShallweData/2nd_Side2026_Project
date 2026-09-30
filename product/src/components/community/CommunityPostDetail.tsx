"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CommunityPostDto } from "@/app/api/community/communityApiContract";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { companyContextLabel, postLanguageLabel, relativeTimeLabel } from "@/components/community/communityFormat";
import { CommunityPostDeleteButton } from "@/components/community/CommunityPostDeleteButton";
import { CommunityReportForm } from "@/components/community/CommunityReportForm";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
import { CommunityApiError, getCommunityPost } from "@/services/communityClient";

interface LoadedPost {
  key: string;
  post: CommunityPostDto | null;
  notFound: boolean;
  error: string | null;
}

export function CommunityPostDetail({ postId }: { postId: string }) {
  const m = useMessages(communityMessages);
  const loadFailedMessage = m.detail.loadFailed;
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
          error: notFound ? null : caught instanceof Error ? caught.message : loadFailedMessage,
        });
      });
    return () => controller.abort();
  }, [requestKey, postId, loadFailedMessage]);

  const post = loading ? null : loaded?.post ?? null;

  return (
    <section aria-label={m.detail.aria} aria-live="polite" aria-busy={loading}>
      {loading ? <LoadingSkeleton label={m.detail.loading} /> : null}
      {!loading && loaded?.notFound ? (
        <EmptyState
          title={m.detail.notFoundTitle}
          description={m.detail.notFoundDescription}
          action={<Link href="/community" className="button button-dark">{m.detail.backToList}</Link>}
        />
      ) : null}
      {!loading && loaded?.error ? (
        <ErrorState message={loaded.error} onRetry={() => setReloadToken((current) => current + 1)} />
      ) : null}
      {post ? (
        <>
          <article className="community-post-card">
            <div>
              <span>{m.categories[post.category] ?? post.category_label}</span>
              <small>
                {[companyContextLabel(post.company_context, m.format), post.author_label ?? m.post.anonymous, relativeTimeLabel(post.created_at, m.format), postLanguageLabel(post.language, m.postLanguage)]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ")}
                {post.updated_at === post.created_at ? "" : ` · ${format(m.post.edited, { time: relativeTimeLabel(post.updated_at, m.format) })}`}
              </small>
            </div>
            <h2 lang={post.language === "other" ? undefined : post.language}>{post.title}</h2><p className="community-post-body" lang={post.language === "other" ? undefined : post.language}>{post.body}</p>
            <strong>{post.like_count === null ? null : `${format(m.post.likes, { count: post.like_count })}　`}{format(m.post.comments, { count: post.comment_count })}</strong>
          </article>
          <p className="field-help">{m.detail.countsNote}</p>
          <div className="community-post-actions">
            {post.viewer_permissions.can_edit ? (
              <Link href={`/community/${encodeURIComponent(post.post_id)}/edit`} className="button button-outline button-small">
                {m.detail.edit}
              </Link>
            ) : null}
            {post.viewer_permissions.can_delete ? (
              <CommunityPostDeleteButton key={post.post_id} postId={post.post_id} />
            ) : null}
            {post.capabilities.reports && post.viewer_permissions.can_report ? (
              <CommunityReportForm key={post.post_id} postId={post.post_id} />
            ) : null}
            <Link href="/community" className="button button-outline button-small">{m.detail.list}</Link>
          </div>
        </>
      ) : null}
    </section>
  );
}
