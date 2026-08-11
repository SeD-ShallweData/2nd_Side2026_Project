import Link from "next/link";
import { Brand } from "@/components/common/SiteHeader";
import { getDataMode } from "@/config/dataMode";

export function SiteFooter() {
  const dataMode = getDataMode();
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div>
          <Brand />
          <p className="footer-copy">
            공공데이터의 관측 신호와 공식 노동 정보를 연결하는 구직자·근로자용 정보 서비스
          </p>
        </div>
        <nav aria-label="하단 메뉴" className="footer-links">
          <Link href="/companies">사업장 확인</Link>
          <Link href="/chat">노동 상담</Link>
          <Link href="/contracts">계약서 확인</Link>
          <Link href="/community">커뮤니티</Link>
          <Link href="/inspector">근로감독관 전용</Link>
        </nav>
        <p className="footer-note">
          본 서비스는 회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다. 현재 사업장 데이터 모드: {dataMode === "real" ? "읽기 전용 DB" : "명시된 데모 데이터"}.
        </p>
      </div>
    </footer>
  );
}
