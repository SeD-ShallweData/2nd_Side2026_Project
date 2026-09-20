"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { AuthApiError, login } from "@/services/authClient";
import { hasGuestConversation } from "@/services/guestConversationClient";
import type { ErrorDetail } from "@/utils/errors";

interface FieldErrors {
  email?: string;
  password?: string;
}

interface SubmitError {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 로그인 자체 실패의 원인은 노출하지 않는다 — 계정 존재 여부가 드러나면 안 된다.
export function submitErrorMessage(error: AuthApiError): string {
  switch (error.code) {
    case "VALIDATION_ERROR":
    case "INVALID_CREDENTIALS":
    case "AUTH_ROLE_UNSUPPORTED":
    case "CROSS_SITE_REQUEST_REJECTED":
      return error.message;
    case "LOGIN_TEMPORARILY_LOCKED": {
      // "잠시 후"는 몇 분인지 알 수 없어 재시도 타이밍을 못 잡는다.
      // 서버가 Retry-After로 보내는 정확한 남은 시간을 분 단위로 알려준다.
      const minutes = error.retryAfterSeconds === null ? null : Math.ceil(error.retryAfterSeconds / 60);
      return minutes === null
        ? error.message
        : `로그인 시도가 너무 많습니다. ${minutes}분 후 다시 시도해 주세요.`;
    }
    default:
      return error.retryable
        ? "인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

export function LoginForm() {
  const router = useRouter();
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!EMAIL_PATTERN.test(email.trim())) {
      errors.email = "올바른 이메일 형식을 입력해 주세요.";
    }
    if (password.length < 1) {
      errors.password = "비밀번호를 입력해 주세요.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const errors = validate();
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      // 이동이 끝날 때까지 submitting을 유지해 중복 제출을 막는다.
      router.push(hasGuestConversation() ? "/chat?guest_import=prompt" : "/community");
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof AuthApiError) {
        setSubmitError({ code: caught.code, message: submitErrorMessage(caught), details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: "네트워크 문제로 로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-email`}>이메일</label>
      <input
        id={`${fieldId}-email`}
        type="email"
        value={email}
        disabled={submitting}
        autoComplete="email"
        placeholder="이메일을 입력해 주세요"
        aria-invalid={Boolean(fieldErrors.email)}
        aria-describedby={fieldErrors.email ? `${fieldId}-email-error` : undefined}
        onChange={(event) => setEmail(event.target.value)}
      />
      {fieldErrors.email ? <p className="field-error" id={`${fieldId}-email-error`} role="alert">{fieldErrors.email}</p> : null}

      <label htmlFor={`${fieldId}-password`}>비밀번호</label>
      <input
        id={`${fieldId}-password`}
        type="password"
        value={password}
        disabled={submitting}
        autoComplete="current-password"
        placeholder="비밀번호를 입력해 주세요"
        aria-invalid={Boolean(fieldErrors.password)}
        aria-describedby={fieldErrors.password ? `${fieldId}-password-error` : undefined}
        onChange={(event) => setPassword(event.target.value)}
      />
      {fieldErrors.password ? <p className="field-error" id={`${fieldId}-password-error`} role="alert">{fieldErrors.password}</p> : null}

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? "로그인 중" : "로그인"}
        </button>
      </div>

      {submitError ? (
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

      <p className="field-help">
        아직 계정이 없으신가요? <Link href="/signup">회원가입</Link>
      </p>
    </form>
  );
}
