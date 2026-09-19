"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/common/SiteHeader";

export function SiteFooterView({ dataMode }: { dataMode: "real" | "mock" }) {
  const pathname = usePathname();

  if (pathname.startsWith("/inspector")) {
    return (
      <footer className="site-footer">
        <div className="shell footer-grid">
          <div><Brand /><p className="footer-copy">공공데이터의 관측 신호와 공식 노동 정보를 연결하는 구직자·근로자용 정보 서비스</p></div>
          {/* 일반 사용자용 메뉴(사업장 확인·노동 상담 등)는 감독 화면과 무관해
              그 자리에 두지 않는다. 대신 Co끼리 로고와 같은 줄에 동아리 로고를
              둔다 — 감독 화면도 같은 팀이 만든 서비스임을 보여준다. */}
          <Image
            className="footer-club-logo"
            src="/brand/sed-club-logo-white.png"
            alt="SeD 동아리 로고"
            width={240}
            height={240}
          />
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
          <p>공개 데이터에서 관측된 사실과 공식 노동 정보를 연결하여 제공합니다.</p>
        </div>
        <p className="consumer-footer-note">Co끼리는 회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다.</p>
      </div>
    </footer>
  );
}
