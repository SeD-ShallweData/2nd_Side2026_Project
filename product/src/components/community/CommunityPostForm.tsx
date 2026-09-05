"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type CommunityCategory,
} from "@/app/api/community/communityApiContract";
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
    if (!category) errors.category = "게시글 분류를 선택해 주세요.";
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < TITLE_MIN || trimmedTitle.length > TITLE_MAX) {
      errors.title = `제목은 ${TITLE_MIN}자 이상 ${TITLE_MAX}자 이하여야 합니다.`;
    }
    const trimmedBody = body.trim();
    if (trimmedBody.length < BODY_MIN || trimmedBody.length > BODY_MAX) {
      errors.body = `내용은 ${BODY_MIN}자 이상 ${BODY_MAX.toLocaleString("ko-KR")}자 이하여야 합니다.`;
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
        message: "네트워크 문제로 게시글을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-category`}>분류</label>
      <select
        id={`${fieldId}-category`}
        value={category}
        disabled={submitting}
        aria-invalid={Boolean(fieldErrors.category)}
        aria-describedby={fieldErrors.category ? `${fieldId}-category-error` : undefined}
        onChange={(event) => setCategory(event.target.value as CommunityCategory | "")}
      >
        <option value="">분류를 선택해 주세요</option>
        {COMMUNITY_CATEGORIES.map((item) => (
          <option key={item} value={item}>{COMMUNITY_CATEGORY_LABELS[item]}</option>
        ))}
      </select>
      {fieldErrors.category ? <p className="field-error" id={`${fieldId}-category-error`} role="alert">{fieldErrors.category}</p> : null}

      <label htmlFor={`${fieldId}-title`}>제목</label>
      <input
        id={`${fieldId}-title`}
        value={title}
        maxLength={TITLE_MAX}
        disabled={submitting}
        autoComplete="off"
        placeholder="확인하고 싶은 내용을 한 줄로 적어주세요"
        aria-invalid={Boolean(fieldErrors.title)}
        aria-describedby={fieldErrors.title ? `${fieldId}-title-error` : `${fieldId}-title-help`}
        onChange={(event) => setTitle(event.target.value)}
      />
      {fieldErrors.title
        ? <p className="field-error" id={`${fieldId}-title-error`} role="alert">{fieldErrors.title}</p>
        : <p className="field-help" id={`${fieldId}-title-help`}>{TITLE_MIN}~{TITLE_MAX}자 · 현재 {title.trim().length}자</p>}

      <label htmlFor={`${fieldId}-body`}>내용</label>
      <textarea
        id={`${fieldId}-body`}
        value={body}
        rows={10}
        maxLength={BODY_MAX}
        disabled={submitting}
        placeholder="겪은 상황과 확인한 방법을 적어주세요. 개인을 특정할 수 있는 정보는 적지 말아주세요."
        aria-invalid={Boolean(fieldErrors.body)}
        aria-describedby={fieldErrors.body ? `${fieldId}-body-error` : `${fieldId}-body-help`}
        onChange={(event) => setBody(event.target.value)}
      />
      {fieldErrors.body
        ? <p className="field-error" id={`${fieldId}-body-error`} role="alert">{fieldErrors.body}</p>
        : <p className="field-help" id={`${fieldId}-body-help`}>{BODY_MIN}~{BODY_MAX.toLocaleString("ko-KR")}자 · 현재 {body.trim().length.toLocaleString("ko-KR")}자</p>}

      <label htmlFor={`${fieldId}-anonymous`}>익명 설정</label>
      <p className="field-help">
        <input
          id={`${fieldId}-anonymous`}
          type="checkbox"
          checked={anonymous}
          disabled={submitting}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
        {" "}익명으로 작성합니다. 해제하면 목록과 상세에 표시 이름이 노출됩니다.
      </p>

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? "등록 중" : "게시글 등록"}
        </button>
        <Link href="/community" className="button button-outline">취소</Link>
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

      <p className="privacy-note">
        <span aria-hidden="true">🔒</span>
        게시글은 사용자 경험이며 공식 데이터나 법률 근거가 아닙니다. 익명 글의 작성자 식별정보는 공개 API에 포함하지 않습니다.
      </p>
    </form>
  );
}
