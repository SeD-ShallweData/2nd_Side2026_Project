"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

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

  return (
    <>
      <header className="consumer-header">
        <div className="shell consumer-header-inner">
          <Link href="/" className="brand-link">
            <Brand />
          </Link>
          <nav className="consumer-main-nav" aria-label="주요 메뉴">
            <Link href="/">서비스 소개</Link>
            <Link href="/companies">사업장 확인</Link>
            <Link href="/contracts">계약서 진단</Link>
            <Link href="/community">커뮤니티</Link>
            <Link href="/chat" className="consumer-ai-link">AI 노동 상담</Link>
          </nav>
          {!isInspector ? (
            <Link href="/inspector" className="consumer-mode-switch" aria-label="일반 사용자 모드에서 근로감독관 모드로 전환">
              근로감독관 모드 <span aria-hidden="true">↗</span>
            </Link>
          ) : null}
        </div>
      </header>
      {!isInspector && pathname !== "/chat" ? (
        <Link href="/chat" className="consumer-floating-chat" aria-label="돈워리와 상담 바로가기">
          <Image src="/brand/donworry-avatar.png" alt="" width={192} height={192} /> 돈워리와 상담
        </Link>
      ) : null}
      <nav className="consumer-mobile-nav" aria-label="모바일 주요 메뉴">
        <Link href="/">소개</Link><Link href="/companies">사업장</Link>
        <Link href="/contracts">계약서</Link><Link href="/community">커뮤니티</Link>
        <Link href="/chat">AI 상담</Link>
      </nav>
    </>
  );
}
