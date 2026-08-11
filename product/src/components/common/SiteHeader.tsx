import Link from "next/link";

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
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link href="/" className="brand-link">
          <Brand />
        </Link>
        <nav className="main-nav" aria-label="주요 메뉴">
          <Link href="/companies">사업장 확인</Link>
          <Link href="/chat">노동 상담</Link>
          <Link href="/contracts">계약서 확인</Link>
          <Link href="/community">커뮤니티</Link>
        </nav>
        <Link href="/companies" className="button button-small button-dark header-cta">
          시작하기
        </Link>
      </div>
      <nav className="mobile-nav" aria-label="모바일 주요 메뉴">
        <Link href="/companies">사업장</Link>
        <Link href="/chat">AI 상담</Link>
        <Link href="/contracts">계약서</Link>
        <Link href="/community">커뮤니티</Link>
      </nav>
    </header>
  );
}
