"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type CommunityCategory,
  type CommunityPostDto,
  type UpdateCommunityPostRequest,
} from "@/app/api/community/communityApiContract";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { CommunityApiError, getCommunityPost, updateCommunityPost } from "@/services/communityClient";
import type { ErrorDetail } from "@/utils/errors";

const TITLE_MIN = 2;
const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 5_000;

interface LoadedPost {
  key: string;
  post: CommunityPostDto | null;
  notFound: boolean;
  error: string | null;
}

interface FieldErrors {
  title?: string;
  body?: string;
}

interface SubmitError {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

export function CommunityPostEditForm({ postId }: { postId: string }) {
  const router = useRouter();
  const fieldId = useId();
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPost | null>(null);
  const [draft, setDraft] = useState<{ category: CommunityCategory; title: string; body: string; anonymous: boolean } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const requestKey = `${reloadToken}|${postId}`;
  const loading = loaded?.key !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    getCommunityPost(postId, { signal: controller.signal })
      .then((post) => {
        setLoaded({ key: requestKey, post, notFound: false, error: null });
        setDraft({
          category: post.category,
          title: post.title,
          body: post.body,
          anonymous: post.anonymous,
        });
      })
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

  function validate(current: NonNullable<typeof draft>): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedTitle = current.title.trim();
    if (trimmedTitle.length < TITLE_MIN || trimmedTitle.length > TITLE_MAX) {
      errors.title = `제목은 ${TITLE_MIN}자 이상 ${TITLE_MAX}자 이하여야 합니다.`;
    }
    const trimmedBody = current.body.trim();
    if (trimmedBody.length < BODY_MIN || trimmedBody.length > BODY_MAX) {
      errors.body = `내용은 ${BODY_MIN}자 이상 ${BODY_MAX.toLocaleString("ko-KR")}자 이하여야 합니다.`;
    }
    return errors;
  }

  // PATCH는 전달한 키만 반영하므로 실제로 바뀐 값만 담는다.
  function buildChanges(source: CommunityPostDto, current: NonNullable<typeof draft>): UpdateCommunityPostRequest {
    const changes: UpdateCommunityPostRequest = {};
    if (current.category !== source.category) changes.category = current.category;
    if (current.title.trim() !== source.title) changes.title = current.title.trim();
    if (current.body.trim() !== source.body) changes.body = current.body.trim();
    if (current.anonymous !== source.anonymous) changes.anonymous = current.anonymous;
    return changes;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !post || !draft) return;

    const errors = validate(draft);
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const updated = await updateCommunityPost(post.post_id, buildChanges(post, draft));
      router.push(`/community/${encodeURIComponent(updated.post_id)}`);
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof CommunityApiError) {
        setSubmitError({ code: caught.code, message: caught.message, details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: "네트워크 문제로 게시글을 수정하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  if (loading) return <LoadingSkeleton label="게시글을 불러오고 있습니다." />;

  if (loaded?.notFound) {
    return (
      <EmptyState
        title="게시글을 찾을 수 없습니다"
        description="삭제되었거나 공개되지 않은 게시글입니다. 커뮤니티 목록에서 다시 확인해 주세요."
        action={<Link href="/community" className="button button-dark">커뮤니티 목록으로</Link>}
      />
    );
  }

  if (loaded?.error) {
    return <ErrorState message={loaded.error} onRetry={() => setReloadToken((current) => current + 1)} />;
  }

  if (!post || !draft) return null;

  // 수정 가능 여부는 서버가 내려준 값을 그대로 사용한다.
  if (!post.viewer_permissions.can_edit) {
    return (
      <EmptyState
        title="게시글을 수정할 수 없습니다"
        description="본인이 작성한 공개 상태의 게시글만 수정할 수 있습니다."
        action={<Link href={`/community/${encodeURIComponent(post.post_id)}`} className="button button-dark">게시글로 돌아가기</Link>}
      />
    );
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-category`}>분류</label>
      <select
        id={`${fieldId}-category`}
        value={draft.category}
        disabled={submitting}
        onChange={(event) => setDraft({ ...draft, category: event.target.value as CommunityCategory })}
      >
        {COMMUNITY_CATEGORIES.map((item) => (
          <option key={item} value={item}>{COMMUNITY_CATEGORY_LABELS[item]}</option>
        ))}
      </select>

      <label htmlFor={`${fieldId}-title`}>제목</label>
      <input
        id={`${fieldId}-title`}
        value={draft.title}
        maxLength={TITLE_MAX}
        disabled={submitting}
        autoComplete="off"
        aria-invalid={Boolean(fieldErrors.title)}
        aria-describedby={fieldErrors.title ? `${fieldId}-title-error` : `${fieldId}-title-help`}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      {fieldErrors.title
        ? <p className="field-error" id={`${fieldId}-title-error`} role="alert">{fieldErrors.title}</p>
        : <p className="field-help" id={`${fieldId}-title-help`}>{TITLE_MIN}~{TITLE_MAX}자 · 현재 {draft.title.trim().length}자</p>}

      <label htmlFor={`${fieldId}-body`}>내용</label>
      <textarea
        id={`${fieldId}-body`}
        value={draft.body}
        rows={10}
        maxLength={BODY_MAX}
        disabled={submitting}
        aria-invalid={Boolean(fieldErrors.body)}
        aria-describedby={fieldErrors.body ? `${fieldId}-body-error` : `${fieldId}-body-help`}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      {fieldErrors.body
        ? <p className="field-error" id={`${fieldId}-body-error`} role="alert">{fieldErrors.body}</p>
        : <p className="field-help" id={`${fieldId}-body-help`}>{BODY_MIN}~{BODY_MAX.toLocaleString("ko-KR")}자 · 현재 {draft.body.trim().length.toLocaleString("ko-KR")}자</p>}

      <label htmlFor={`${fieldId}-anonymous`}>익명 설정</label>
      <p className="field-help">
        <input
          id={`${fieldId}-anonymous`}
          type="checkbox"
          checked={draft.anonymous}
          disabled={submitting}
          onChange={(event) => setDraft({ ...draft, anonymous: event.target.checked })}
        />
        {" "}익명으로 표시합니다. 해제하면 목록과 상세에 표시 이름이 노출됩니다.
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? "저장 중" : "수정 저장"}
        </button>
        <Link href={`/community/${encodeURIComponent(post.post_id)}`} className="button button-outline">취소</Link>
      </div>

      {submitError?.code === "AUTHENTICATION_REQUIRED" ? (
        <p className="field-error" role="alert">로그인이 필요합니다. 로그인한 뒤 다시 시도해 주세요.</p>
      ) : null}
      {submitError && submitError.code !== "AUTHENTICATION_REQUIRED" ? (
        <>
          <p className="field-error" role="alert">{submitError.message}</p>
          {submitError.details?.length ? (
            <ul className="field-help">
              {submitError.details.map((detail, index) => (
                <li key={`${detail.field ?? "detail"}-${index}`}>
                  {detail.field ? `${detail.field} · ` : ""}{detail.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </form>
  );
}
