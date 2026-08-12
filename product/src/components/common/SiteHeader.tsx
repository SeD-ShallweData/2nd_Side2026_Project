"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Brand() {
  return (
    <span className="brand" aria-label="돈워리 홈">
      <span className="brand-mark" aria-hidden="true">
        돈
      </span>
      <span className="brand-word">돈워리</span>
    </span>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  if (pathname.startsWith("/inspector")) {
    return (
      <header className="site-header">
        <div className="shell header-inner">
          <Link href="/" className="brand-link"><Brand /></Link>
          <nav className="main-nav" aria-label="주요 메뉴">
            <Link href="/companies">사업장 확인</Link>
            <Link href="/chat">노동 상담</Link>
            <Link href="/contracts">계약서 확인</Link>
            <Link href="/community">커뮤니티</Link>
          </nav>
          <Link href="/companies" className="button button-small button-dark header-cta">시작하기</Link>
        </div>
        <nav className="mobile-nav" aria-label="모바일 주요 메뉴">
          <Link href="/companies">사업장</Link><Link href="/chat">AI 상담</Link>
          <Link href="/contracts">계약서</Link><Link href="/community">커뮤니티</Link>
        </nav>
      </header>
    );
  }

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
      </div>
      </header>
      {pathname !== "/chat" ? (
        <Link href="/chat" className="consumer-floating-chat" aria-label="AI 노동 상담 바로가기">
          <span>AI</span> 바로 상담
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
