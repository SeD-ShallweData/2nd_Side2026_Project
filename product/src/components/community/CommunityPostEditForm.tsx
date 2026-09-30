"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  type CommunityCategory,
  type CommunityPostDto,
  type UpdateCommunityPostRequest,
} from "@/app/api/community/communityApiContract";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
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
  const m = useMessages(communityMessages);
  const n = (value: number) => value.toLocaleString(m.numberLocale);
  const loadFailedMessage = m.detail.loadFailed;
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
          error: notFound ? null : caught instanceof Error ? caught.message : loadFailedMessage,
        });
      });
    return () => controller.abort();
  }, [requestKey, postId, loadFailedMessage]);

  const post = loading ? null : loaded?.post ?? null;

  function validate(current: NonNullable<typeof draft>): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedTitle = current.title.trim();
    if (trimmedTitle.length < TITLE_MIN || trimmedTitle.length > TITLE_MAX) {
      errors.title = format(m.form.titleLength, { min: TITLE_MIN, max: TITLE_MAX });
    }
    const trimmedBody = current.body.trim();
    if (trimmedBody.length < BODY_MIN || trimmedBody.length > BODY_MAX) {
      errors.body = format(m.form.bodyLength, { min: BODY_MIN, max: n(BODY_MAX) });
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
        message: m.edit.networkError,
      });
    }
  }

  if (loading) return <LoadingSkeleton label={m.detail.loading} />;

  if (loaded?.notFound) {
    return (
      <EmptyState
        title={m.detail.notFoundTitle}
        description={m.detail.notFoundDescription}
        action={<Link href="/community" className="button button-dark">{m.detail.backToList}</Link>}
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
        title={m.edit.cannotEditTitle}
        description={m.edit.cannotEditDescription}
        action={<Link href={`/community/${encodeURIComponent(post.post_id)}`} className="button button-dark">{m.edit.backToPost}</Link>}
      />
    );
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-category`}>{m.form.category}</label>
      <select
        id={`${fieldId}-category`}
        value={draft.category}
        disabled={submitting}
        onChange={(event) => setDraft({ ...draft, category: event.target.value as CommunityCategory })}
      >
        {COMMUNITY_CATEGORIES.map((item) => (
          <option key={item} value={item}>{m.categories[item]}</option>
        ))}
      </select>

      <label htmlFor={`${fieldId}-title`}>{m.form.title}</label>
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
        : <p className="field-help" id={`${fieldId}-title-help`}>{format(m.form.lengthHelp, { min: TITLE_MIN, max: TITLE_MAX, count: draft.title.trim().length })}</p>}

      <label htmlFor={`${fieldId}-body`}>{m.form.body}</label>
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
        : <p className="field-help" id={`${fieldId}-body-help`}>{format(m.form.lengthHelp, { min: BODY_MIN, max: n(BODY_MAX), count: n(draft.body.trim().length) })}</p>}

      <label htmlFor={`${fieldId}-anonymous`}>{m.form.anonymousLabel}</label>
      <p className="field-help">
        <input
          id={`${fieldId}-anonymous`}
          type="checkbox"
          checked={draft.anonymous}
          disabled={submitting}
          onChange={(event) => setDraft({ ...draft, anonymous: event.target.checked })}
        />
        {" "}{m.edit.anonymousEdit}
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? m.edit.saving : m.edit.save}
        </button>
        <Link href={`/community/${encodeURIComponent(post.post_id)}`} className="button button-outline">{m.form.cancel}</Link>
      </div>

      {submitError?.code === "AUTHENTICATION_REQUIRED" ? (
        <p className="field-error" role="alert">{m.form.loginRequired}</p>
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
