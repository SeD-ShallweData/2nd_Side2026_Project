"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { AuthApiError, signup } from "@/services/authClient";
import type { ErrorDetail } from "@/utils/errors";
import { format, type MessageShape } from "@/i18n/defineMessages";
import { useMessages } from "@/i18n/LocaleProvider";
import { authMessages } from "@/i18n/messages/auth";

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

function submitErrorMessage(error: AuthApiError, m: MessageShape<typeof authMessages.ko>["errors"]): string {
  switch (error.code) {
    case "VALIDATION_ERROR":
    case "EMAIL_ALREADY_REGISTERED":
    case "CROSS_SITE_REQUEST_REJECTED":
      return error.message;
    default:
      return error.retryable
        ? m.unavailable
        : m.failed;
  }
}

export function SignupForm() {
  const messages = useMessages(authMessages);
  const f = messages.fields;
  const m = messages.signup;
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
      errors.name = format(f.nameInvalid, { max: NAME_MAX });
    }
    const trimmedEmail = email.trim();
    if (!EMAIL_PATTERN.test(trimmedEmail) || trimmedEmail.length > EMAIL_MAX) {
      errors.email = f.emailInvalid;
    }
    if (
      password.length < PASSWORD_MIN
      || password.length > PASSWORD_MAX
      || !PASSWORD_ALLOWED_PATTERN.test(password)
    ) {
      errors.password = format(f.passwordInvalid, { min: PASSWORD_MIN, max: PASSWORD_MAX });
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
        setSubmitError({ code: caught.code, message: submitErrorMessage(caught, messages.errors), details: caught.details });
        return;
      }
      setSubmitError({
        code: "NETWORK_ERROR",
        message: messages.errors.signupNetwork,
      });
    }
  }

  return (
    <form className="search-form auth-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor={`${fieldId}-name`}>{f.name}</label>
      <input
        id={`${fieldId}-name`}
        value={name}
        maxLength={NAME_MAX}
        disabled={submitting}
        autoComplete="name"
        placeholder={f.namePlaceholder}
        aria-invalid={Boolean(fieldErrors.name)}
        aria-describedby={fieldErrors.name ? `${fieldId}-name-error` : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {fieldErrors.name ? <p className="field-error" id={`${fieldId}-name-error`} role="alert">{fieldErrors.name}</p> : null}

      <label htmlFor={`${fieldId}-email`}>{f.email}</label>
      <input
        id={`${fieldId}-email`}
        type="email"
        value={email}
        maxLength={EMAIL_MAX}
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
        maxLength={PASSWORD_MAX}
        disabled={submitting}
        autoComplete="new-password"
        placeholder={f.passwordPlaceholder}
        aria-invalid={Boolean(fieldErrors.password)}
        aria-describedby={fieldErrors.password ? `${fieldId}-password-error` : `${fieldId}-password-help`}
        onChange={(event) => setPassword(event.target.value)}
      />
      {fieldErrors.password
        ? <p className="field-error" id={`${fieldId}-password-error`} role="alert">{fieldErrors.password}</p>
        : (
          <p className="field-help" id={`${fieldId}-password-help`}>
            {format(f.passwordHelp, { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          </p>
        )}

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
        {m.hasAccount} <Link href="/login">{m.loginLink}</Link>
      </p>
    </form>
  );
}
