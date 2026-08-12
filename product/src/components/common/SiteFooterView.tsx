"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/common/SiteHeader";

export function SiteFooterView({ dataMode }: { dataMode: "real" | "mock" }) {
  const pathname = usePathname();

  if (pathname.startsWith("/inspector")) {
    return (
      <footer className="site-footer">
        <div className="shell footer-grid">
          <div><Brand /><p className="footer-copy">공공데이터의 관측 신호와 공식 노동 정보를 연결하는 구직자·근로자용 정보 서비스</p></div>
          <nav aria-label="하단 메뉴" className="footer-links">
            <Link href="/companies">사업장 확인</Link><Link href="/chat">노동 상담</Link>
            <Link href="/contracts">계약서 확인</Link><Link href="/community">커뮤니티</Link>
            <Link href="/inspector">근로감독관 전용</Link>
          </nav>
          <p className="footer-note">본 서비스는 회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다. 현재 사업장 데이터 모드: {dataMode === "real" ? "읽기 전용 DB" : "명시된 데모 데이터"}.</p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="consumer-footer">
      <div className="shell consumer-footer-grid">
        <div>
          <Brand />
          <p>공개 데이터에서 관측된 사실과 공식 노동 정보를 연결해, 일하기 전과 일하는 중의 확인을 돕습니다.</p>
        </div>
        <nav aria-label="하단 메뉴">
          <Link href="/">서비스 소개</Link><Link href="/companies">사업장 확인</Link>
          <Link href="/contracts">계약서 진단</Link><Link href="/community">커뮤니티</Link>
          <Link href="/chat">AI 노동 상담</Link><Link href="/inspector" className="inspector-footer-link">근로감독관 전용 ↗</Link>
        </nav>
        <p className="consumer-footer-note">돈워리는 회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다. 현재 사업장 데이터: {dataMode === "real" ? "읽기 전용 DB" : "명시된 데모 데이터"}</p>
      </div>
    </footer>
  );
}
