"use client";

import Link from "next/link";

import { format } from "@/i18n/defineMessages";

export interface AppErrorViewText {
  title: string;
  desc: string;
  /** "{code}" 자리에 문의 코드가 들어간다. */
  reference: string;
  retry: string;
  home: string;
}

/*
 * 화면 오류 경계(app/error.tsx)의 본문.
 *
 * error.message 와 stack 은 절대 그리지 않는다. 운영 빌드에서 서버 컴포넌트 오류의 message 는
 * 가려지지만, 클라이언트 컴포넌트에서 난 오류는 원문이 그대로 넘어오기 때문이다.
 * 그래서 이 부품은 오류 객체를 받지 않고, digest 로 만든 문의 코드만 받는다(utils/errorReference.ts).
 */
export function AppErrorView({
  text,
  referenceCode,
  onRetry,
}: {
  text: AppErrorViewText;
  referenceCode: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="page-section">
      <div className="shell narrow-shell">
        <div className="state-card state-error not-found-card" role="alert">
          <span className="state-icon" aria-hidden="true">
            !
          </span>
          <h1>{text.title}</h1>
          <p>{text.desc}</p>
          {referenceCode ? <p>{format(text.reference, { code: referenceCode })}</p> : null}
          <button type="button" className="button button-dark" onClick={onRetry}>
            {text.retry}
          </button>
          <Link href="/">{text.home}</Link>
        </div>
      </div>
    </div>
  );
}
