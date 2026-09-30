"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  type CommunityCategory,
} from "@/app/api/community/communityApiContract";
import { format } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { communityMessages } from "@/i18n/messages/community";
import { CommunityApiError, createCommunityPost } from "@/services/communityClient";
import type { ErrorDetail } from "@/utils/errors";

const TITLE_MIN = 2;
const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 5_000;

interface FieldErrors {
  category?: string;
  title?: string;
  body?: string;
}

interface SubmitError {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

export function CommunityPostForm() {
  const m = useMessages(communityMessages);
  const n = (value: number) => value.toLocaleString(m.numberLocale);
  const router = useRouter();
  const fieldId = useId();
  const [category, setCategory] = useState<CommunityCategory | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!category) errors.category = m.form.categoryRequired;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < TITLE_MIN || trimmedTitle.length > TITLE_MAX) {
      errors.title = format(m.form.titleLength, { min: TITLE_MIN, max: TITLE_MAX });
    }
    const trimmedBody = body.trim();
    if (trimmedBody.length < BODY_MIN || trimmedBody.length > BODY_MAX) {
      errors.body = format(m.form.bodyLength, { min: BODY_MIN, max: n(BODY_MAX) });
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const errors = validate();
    setFieldErrors(errors);
    setSubmitError(null);
    if (!category || Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      // company_id 선택 UI가 없으므로 이번 단계에서는 전송하지 않는다.
      const post = await createCommunityPost({
        category,
        title: title.trim(),
        body: body.trim(),
        anonymous,
      });
      // 이동이 끝날 때까지 submitting을 유지해 중복 제출을 막는다.
      router.push(`/community/${encodeURIComponent(post.post_id)}`);
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof CommunityApiError) {
        setSubmitError({ code: caught.code, message: caught.message, details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: m.form.createNetworkError,
      });
    }
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-category`}>{m.form.category}</label>
      <select
        id={`${fieldId}-category`}
        value={category}
        disabled={submitting}
        aria-invalid={Boolean(fieldErrors.category)}
        aria-describedby={fieldErrors.category ? `${fieldId}-category-error` : undefined}
        onChange={(event) => setCategory(event.target.value as CommunityCategory | "")}
      >
        <option value="">{m.form.categoryPlaceholder}</option>
        {COMMUNITY_CATEGORIES.map((item) => (
          <option key={item} value={item}>{m.categories[item]}</option>
        ))}
      </select>
      {fieldErrors.category ? <p className="field-error" id={`${fieldId}-category-error`} role="alert">{fieldErrors.category}</p> : null}

      <label htmlFor={`${fieldId}-title`}>{m.form.title}</label>
      <input
        id={`${fieldId}-title`}
        value={title}
        maxLength={TITLE_MAX}
        disabled={submitting}
        autoComplete="off"
        placeholder={m.form.titlePlaceholder}
        aria-invalid={Boolean(fieldErrors.title)}
        aria-describedby={fieldErrors.title ? `${fieldId}-title-error` : `${fieldId}-title-help`}
        onChange={(event) => setTitle(event.target.value)}
      />
      {fieldErrors.title
        ? <p className="field-error" id={`${fieldId}-title-error`} role="alert">{fieldErrors.title}</p>
        : <p className="field-help" id={`${fieldId}-title-help`}>{format(m.form.lengthHelp, { min: TITLE_MIN, max: TITLE_MAX, count: title.trim().length })}</p>}

      <label htmlFor={`${fieldId}-body`}>{m.form.body}</label>
      <textarea
        id={`${fieldId}-body`}
        value={body}
        rows={10}
        maxLength={BODY_MAX}
        disabled={submitting}
        placeholder={m.form.bodyPlaceholder}
        aria-invalid={Boolean(fieldErrors.body)}
        aria-describedby={fieldErrors.body ? `${fieldId}-body-error` : `${fieldId}-body-help`}
        onChange={(event) => setBody(event.target.value)}
      />
      {fieldErrors.body
        ? <p className="field-error" id={`${fieldId}-body-error`} role="alert">{fieldErrors.body}</p>
        : <p className="field-help" id={`${fieldId}-body-help`}>{format(m.form.lengthHelp, { min: BODY_MIN, max: n(BODY_MAX), count: n(body.trim().length) })}</p>}

      <label htmlFor={`${fieldId}-anonymous`}>{m.form.anonymousLabel}</label>
      <p className="field-help">
        <input
          id={`${fieldId}-anonymous`}
          type="checkbox"
          checked={anonymous}
          disabled={submitting}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
        {" "}{m.form.anonymousCreate}
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? m.form.submitting : m.form.submit}
        </button>
        <Link href="/community" className="button button-outline">{m.form.cancel}</Link>
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

      <p className="privacy-note">
        <span aria-hidden="true">🔒</span>
        {m.form.privacyNote}
      </p>
    </form>
  );
}
