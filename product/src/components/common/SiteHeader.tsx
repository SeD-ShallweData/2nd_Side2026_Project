"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import type { SessionResponse } from "@/app/api/auth/authApiContract";
import { AuthApiError, getSession, logout } from "@/services/authClient";

const NAV_ITEMS = [
  { href: "/", label: "서비스 소개" },
  { href: "/companies", label: "사업장 확인" },
  { href: "/contracts", label: "계약서 진단" },
  { href: "/community", label: "커뮤니티" },
  { href: "/worksite-tips", label: "현장 신고" },
] as const;

const MOBILE_NAV_ITEMS = [
  { href: "/", label: "소개" },
  { href: "/companies", label: "사업장" },
  { href: "/contracts", label: "계약서" },
  { href: "/community", label: "커뮤니티" },
  { href: "/worksite-tips", label: "현장 신고" },
  { href: "/chat", label: "AI 상담" },
] as const;

// "/" 는 정확히 일치할 때만 현재 탭이다. 접두사로 보면 모든 경로가 홈이 된다.
export function isCurrentNavPath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

type SessionState =
  | { status: "loading" }
  | { status: "ready"; session: SessionResponse };

export function Brand() {
  return (
    <span className="brand" aria-label="Co끼리 홈">
      {/* alt 를 비워 장식으로 표시한다 — 이름은 옆의 brand-word 가 읽어 준다. */}
      <Image
        className="brand-mark"
        src="/brand/logo.png"
        alt=""
        width={192}
        height={192}
        priority
      />
      <span className="brand-word">Co끼리</span>
    </span>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const isInspector = pathname.startsWith("/inspector");
  const [sessionState, setSessionState] = useState<SessionState>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    // 민규님의 공통 auth-change 이벤트가 아직 없어, 경로가 바뀔 때마다
    // 로컬에서 다시 세션을 조회한다. 로그인/회원가입 성공 후 /community로
    // 이동하는 시점에 헤더가 새 세션을 반영하도록 하기 위한 임시 처리다.
    let ignore = false;
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((session) => {
        if (ignore) return;
        setSessionState({ status: "ready", session });
        setLogoutError(null);
      })
      .catch(() => {
        if (!ignore) {
          setSessionState({
            status: "ready",
            session: { authenticated: false, user: null, expires_at: null },
          });
        }
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [pathname]);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      // 공통 세션 갱신 구조가 아직 없어, 로그아웃 후에는 커뮤니티 글쓰기 권한 등
      // 다른 컴포넌트가 이전 로그인 상태를 들고 있지 않도록 전체 페이지를 다시 불러온다.
      // 같은 origin의 protocol-relative URL을 써서 next/next의
      // no-location-assign-relative-destination 규칙(상대 경로 전체 이동 금지)을
      // 우회 없이 만족시키면서도 동일한 하드 리로드 동작을 유지한다.
      window.location.assign(`//${window.location.host}/community`);
    } catch (error) {
      setLoggingOut(false);
      setLogoutError(
        error instanceof AuthApiError
          ? "로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요."
          : "네트워크 문제로 로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  }

  const user =
    sessionState.status === "ready" && sessionState.session.authenticated
      ? sessionState.session.user
      : null;

  return (
    <>
      <header className="consumer-header">
        <div className="shell consumer-header-inner">
          {/* 모드 전환은 로고 바로 옆에 둔다. 오른쪽 계정 영역에 있으면
              로그인·로그아웃과 같은 성격으로 읽힌다. */}
          <div className="consumer-header-lead">
            <Link href="/" className="brand-link">
              <Brand />
            </Link>
            {/* 감독관도 ML 대시보드를 읽기 전용으로 봐야 하므로 admin 과 함께 노출한다.
                라벨만 역할에 맞게 갈린다 — 실제 화면 범위는 InspectorNav 가 이미 나눠서 보여준다. */}
            {/* server/auth/inspectorAccess.ts 의 INSPECTION_ROLES 와 같은 값이다.
                그 파일은 "server-only" 라 클라이언트 컴포넌트에서 가져올 수 없어 여기 그대로 둔다. */}
            {!isInspector && (user?.role === "admin" || user?.role === "inspector") ? (
              <Link
                /* 관리자는 이 화면에서 배치·프롬프트를 직접 운영하므로 곧바로
                   LLM 프롬프트 탭으로 보낸다. 감독관은 자기 업무 화면인
                   사업장 대시보드로 그대로 간다. */
                href={user?.role === "admin" ? "/inspector/prompts" : "/inspector"}
                className="consumer-mode-switch"
                aria-label={`일반 사용자 모드에서 ${user?.role === "admin" ? "관리자" : "감독관"} 모드로 전환`}
              >
                {user?.role === "admin" ? "관리자 모드" : "감독관 모드"} <span aria-hidden="true">↗</span>
              </Link>
            ) : null}
          </div>
          <nav className="consumer-main-nav" aria-label="주요 메뉴">
            {NAV_ITEMS.map((item) => {
              const current = isCurrentNavPath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={current ? "is-current" : undefined}
                  aria-current={current ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
            {/* 즐겨찾기는 일반 사용자 전용 기능이라 admin/inspector에게는 보이지 않는다.
                NAV_ITEMS는 로그인 여부와 무관한 공통 메뉴라 여기에 넣지 않는다. */}
            {user?.role === "user" ? (
              <Link
                href="/favorites"
                className={isCurrentNavPath(pathname, "/favorites") ? "is-current" : undefined}
                aria-current={isCurrentNavPath(pathname, "/favorites") ? "page" : undefined}
              >
                즐겨찾기
              </Link>
            ) : null}
          </nav>
          <div className="consumer-header-side" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {sessionState.status === "loading" ? null : user ? (
              <div className="consumer-header-account" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="muted-text">{(user.display_name || "사용자").trim() || "사용자"}님</span>
                {user.role === "admin" ? (
                  <Link href="/admin" className="button button-outline button-small">신고 관리</Link>
                ) : null}
                <button
                  type="button"
                  className="button button-outline button-small"
                  disabled={loggingOut}
                  onClick={handleLogout}
                >
                  {loggingOut ? "로그아웃 중" : "로그아웃"}
                </button>
              </div>
            ) : (
              <Link href="/login" className="button button-dark button-small">로그인</Link>
            )}
          </div>
        </div>
      </header>
      {logoutError ? (
        <p className="shell field-error" role="alert">{logoutError}</p>
      ) : null}
      {!isInspector && pathname !== "/chat" ? (
        <Link href="/chat" className="consumer-floating-chat" aria-label="돈워리 AI에게 상담하기">
          <Image src="/brand/donworry-avatar.png" alt="" width={192} height={192} />
          <span className="consumer-floating-chat-label">돈워리 AI에게 상담하기</span>
        </Link>
      ) : null}
      <nav className="consumer-mobile-nav" aria-label="모바일 주요 메뉴">
        {MOBILE_NAV_ITEMS.map((item) => {
          const current = isCurrentNavPath(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={current ? "is-current" : undefined}
              aria-current={current ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
        {user?.role === "user" ? (
          <Link
            href="/favorites"
            className={isCurrentNavPath(pathname, "/favorites") ? "is-current" : undefined}
            aria-current={isCurrentNavPath(pathname, "/favorites") ? "page" : undefined}
          >
            즐겨찾기
          </Link>
        ) : null}
      </nav>
    </>
  );
}
