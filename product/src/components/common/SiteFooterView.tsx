"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/common/SiteHeader";

export function SiteFooterView() {
  const pathname = usePathname();

  if (pathname.startsWith("/inspector")) {
    return (
      <footer className="site-footer">
        <div className="shell footer-grid">
          <div><Brand /><p className="footer-copy">공공데이터의 관측 신호와 공식 노동 정보를 연결하는 구직자·근로자용 정보 서비스</p></div>
          {/* 다른 탭(소비자 footer)과 같은 배치: 로고를 위에, 동아리 이름을
              그 아래 캡션으로 둔다. 로고 자리 자체는 그대로 오른쪽에 둔다. */}
          <div className="footer-right">
            <Image
              className="footer-club-logo"
              src="/brand/sed-club-logo-white.png"
              alt="SeD 동아리 로고"
              width={240}
              height={240}
            />
            <p className="footer-note">본 서비스는 회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다.</p>
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="consumer-footer">
      <div className="shell consumer-footer-grid">
        <div>
          <Brand />
          <p>Co끼리는 공개 데이터에서 관측된 사실과 공식 노동 정보를 연결하여 제공하며<br />회사의 안전·위법 여부나 입사 결정을 확정하지 않습니다.</p>
        </div>
        {/* 동아리 로고를 위에, 로고를 설명하는 이름을 그 아래 캡션으로 둔다. */}
        <div className="consumer-footer-right">
          <Image
            className="footer-club-logo"
            src="/brand/sed-club-logo-white.png"
            alt="SeD 동아리 로고"
            width={240}
            height={240}
          />
          <p className="consumer-footer-note">인천대학교 데이터사이언스 연합 동아리 SeD(Shall we Data?)</p>
        </div>
      </div>
    </footer>
  );
}
