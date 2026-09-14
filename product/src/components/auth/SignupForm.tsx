"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { AuthApiError, signup } from "@/services/authClient";
import type { ErrorDetail } from "@/utils/errors";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

interface SubmitError {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const NAME_MAX = 40;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 30;
// 서버(authService.ts)의 PASSWORD_ALLOWED_PATTERN과 동일하다 — 공백 없는 ASCII 출력 문자만 허용한다.
const PASSWORD_ALLOWED_PATTERN = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/;

function submitErrorMessage(error: AuthApiError): string {
  switch (error.code) {
    case "VALIDATION_ERROR":
    case "EMAIL_ALREADY_REGISTERED":
    case "CROSS_SITE_REQUEST_REJECTED":
      return error.message;
    default:
      return error.retryable
        ? "인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

export function SignupForm() {
  const router = useRouter();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > NAME_MAX) {
      errors.name = `이름은 1자 이상 ${NAME_MAX}자 이하여야 합니다.`;
    }
    const trimmedEmail = email.trim();
    if (!EMAIL_PATTERN.test(trimmedEmail) || trimmedEmail.length > EMAIL_MAX) {
      errors.email = "올바른 이메일 형식을 입력해 주세요.";
    }
    if (
      password.length < PASSWORD_MIN
      || password.length > PASSWORD_MAX
      || !PASSWORD_ALLOWED_PATTERN.test(password)
    ) {
      errors.password = `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자의 영문, 숫자, 특수문자를 사용할 수 있습니다.`;
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
      await signup({ email: email.trim(), password, name: name.trim() });
      // 이동이 끝날 때까지 submitting을 유지해 중복 제출을 막는다.
      router.push("/community");
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof AuthApiError) {
        setSubmitError({ code: caught.code, message: submitErrorMessage(caught), details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: "네트워크 문제로 가입하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  }

  return (
    <form className="search-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-name`}>이름</label>
      <input
        id={`${fieldId}-name`}
        value={name}
        maxLength={NAME_MAX}
        disabled={submitting}
        autoComplete="name"
        placeholder="이름을 입력해 주세요"
        aria-invalid={Boolean(fieldErrors.name)}
        aria-describedby={fieldErrors.name ? `${fieldId}-name-error` : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {fieldErrors.name ? <p className="field-error" id={`${fieldId}-name-error`} role="alert">{fieldErrors.name}</p> : null}

      <label htmlFor={`${fieldId}-email`}>이메일</label>
      <input
        id={`${fieldId}-email`}
        type="email"
        value={email}
        maxLength={EMAIL_MAX}
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
        maxLength={PASSWORD_MAX}
        disabled={submitting}
        autoComplete="new-password"
        placeholder="비밀번호를 입력해 주세요"
        aria-invalid={Boolean(fieldErrors.password)}
        aria-describedby={fieldErrors.password ? `${fieldId}-password-error` : `${fieldId}-password-help`}
        onChange={(event) => setPassword(event.target.value)}
      />
      {fieldErrors.password
        ? <p className="field-error" id={`${fieldId}-password-error`} role="alert">{fieldErrors.password}</p>
        : (
          <p className="field-help" id={`${fieldId}-password-help`}>
            {PASSWORD_MIN}~{PASSWORD_MAX}자의 영문, 숫자, 특수문자를 사용할 수 있습니다. 이메일 아이디는 포함할 수 없습니다.
          </p>
        )}

      <div className="contract-actions">
        <button type="submit" className="button button-dark" disabled={submitting}>
          {submitting ? "가입 중" : "회원가입"}
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
        이미 계정이 있으신가요? <Link href="/login">로그인</Link>
      </p>
    </form>
  );
}
