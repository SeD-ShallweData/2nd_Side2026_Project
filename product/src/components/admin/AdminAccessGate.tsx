"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { ErrorState, LoadingSkeleton } from "@/components/common/AsyncStates";
import { getSession } from "@/services/authClient";

type GateState =
  | { status: "checking" }
  | { status: "denied"; reason: "unauthenticated" | "not_admin" }
  | { status: "error"; message: string }
  | { status: "ok" };

/*
 * 화면 진입 편의를 위한 UX 차원의 role 확인이다. 최종 보안은 moderation API의
 * 401/403이며, 여기서 통과했더라도 이후 API 호출이 그대로 막힐 수 있다.
 */
export function AdminAccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "checking" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((session) => {
        if (cancelled) return;
        if (!session.authenticated) {
          setState({ status: "denied", reason: "unauthenticated" });
          return;
        }
        if (session.user.role !== "admin") {
          setState({ status: "denied", reason: "not_admin" });
          return;
        }
        setState({ status: "ok" });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "error", message: "로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      });
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  if (state.status === "checking") {
    return <LoadingSkeleton label="관리자 권한을 확인하고 있습니다." />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        message={state.message}
        onRetry={() => {
          setState({ status: "checking" });
          setRetryToken((current) => current + 1);
        }}
      />
    );
  }

  if (state.status === "denied") {
    return (
      <div className="state-card" role="alert">
        <span className="state-icon" aria-hidden="true">!</span>
        <h2>관리자 권한이 필요한 화면입니다</h2>
        <p>
          {state.reason === "unauthenticated"
            ? "로그인 후 관리자 계정으로 다시 접속해 주세요."
            : "현재 계정에는 신고 관리 권한이 없습니다."}
        </p>
        {state.reason === "unauthenticated" ? (
          <Link href="/login" className="button button-dark">로그인</Link>
        ) : null}
      </div>
    );
  }

  return <>{children}</>;
}
