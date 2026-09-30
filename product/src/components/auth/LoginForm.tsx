"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { AuthApiError, login } from "@/services/authClient";
import { hasGuestConversation } from "@/services/guestConversationClient";
import type { ErrorDetail } from "@/utils/errors";
import { format, type MessageShape } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { authMessages } from "@/i18n/messages/auth";

type AuthErrorMessages = MessageShape<typeof authMessages.ko>["errors"];

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

/*
 * 로그인 페이지로 오기 전 있던 화면으로 돌아가기 위한 next 쿼리다. 외부 사이트로
 * 보내는 open redirect를 막기 위해 "/"로 시작하고 "//"(프로토콜 상대 URL)나
 * "\"(일부 파서가 "/"로 취급하는 백슬래시 트릭)는 포함하지 않는 내부 상대 경로만
 * 허용한다. 그 외에는 전부 버리고 기존 기본 동작(/community)으로 되돌린다.
 */
export function resolveSafeNextPath(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  return next;
}

/*
 * 로그인 성공 후 이동을 실행하는 바로 그 순간에 호출해야 한다. mount 시점에
 * 한 번만 읽어 state에 저장해 두면, Next.js가 쿼리만 다른 `/login` 재방문에서
 * 같은 LoginForm 인스턴스를 재사용할 경우(주소창은 새 next로 바뀌어도) 오래된
 * 값을 계속 쓰게 된다 — 그래서 이 함수는 절대 useState 초기값으로 캐싱하지 않는다.
 */
export function readNextPathFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return resolveSafeNextPath(new URLSearchParams(window.location.search).get("next"));
}

/*
 * guest 대화 가져오기는 next보다 먼저였던 기존 정책이라 그대로 최우선으로 둔다 —
 * 그 다음이 로그인 전 있던 화면(next), 둘 다 없으면 기존 기본값인 커뮤니티다.
 */
export function resolveLoginRedirect(options: { hasGuestConversation: boolean; nextPath: string | null }): string {
  if (options.hasGuestConversation) return "/chat?guest_import=prompt";
  return options.nextPath ?? "/community";
}

// 로그인 자체 실패의 원인은 노출하지 않는다 — 계정 존재 여부가 드러나면 안 된다.
// 서버 문구(error.message)는 받은 그대로 두고, 화면이 만드는 문구만 현재 언어 사전에서 고른다.
export function submitErrorMessage(error: AuthApiError, m: AuthErrorMessages = authMessages.ko.errors): string {
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
        : format(m.locked, { minutes });
    }
    default:
      return error.retryable
        ? m.unavailable
        : m.failed;
  }
}

export function LoginForm() {
  const messages = useMessages(authMessages);
  const f = messages.fields;
  const m = messages.login;
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
      errors.email = f.emailInvalid;
    }
    if (password.length < 1) {
      errors.password = f.passwordRequired;
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
      // next는 여기서, 이동을 실행하는 시점에 다시 읽는다(readNextPathFromLocation 주석 참고).
      router.push(
        resolveLoginRedirect({
          hasGuestConversation: hasGuestConversation(),
          nextPath: readNextPathFromLocation(),
        }),
      );
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof AuthApiError) {
        setSubmitError({ code: caught.code, message: submitErrorMessage(caught, messages.errors), details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: messages.errors.loginNetwork,
      });
    }
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-email`}>{f.email}</label>
      <input
        id={`${fieldId}-email`}
        type="email"
        value={email}
        disabled={submitting}
        autoComplete="email"
        placeholder={f.emailPlaceholder}
        aria-invalid={Boolean(fieldErrors.email)}
        aria-describedby={fieldErrors.email ? `${fieldId}-email-error` : undefined}
        onChange={(event) => setEmail(event.target.value)}
      />
      {fieldErrors.email ? <p className="field-error" id={`${fieldId}-email-error`} role="alert">{fieldErrors.email}</p> : null}

      <label htmlFor={`${fieldId}-password`}>{f.password}</label>
      <input
        id={`${fieldId}-password`}
        type="password"
        value={password}
        disabled={submitting}
        autoComplete="current-password"
        placeholder={f.passwordPlaceholder}
        aria-invalid={Boolean(fieldErrors.password)}
        aria-describedby={fieldErrors.password ? `${fieldId}-password-error` : undefined}
        onChange={(event) => setPassword(event.target.value)}
      />
      {fieldErrors.password ? <p className="field-error" id={`${fieldId}-password-error`} role="alert">{fieldErrors.password}</p> : null}

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? m.submitting : m.submit}
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
        {m.noAccount} <Link href="/signup">{m.signupLink}</Link>
      </p>
    </form>
  );
}
