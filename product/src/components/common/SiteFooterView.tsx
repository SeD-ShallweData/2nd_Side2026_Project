"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/common/SiteHeader";
import { withMobileBreaks } from "@/components/common/MobileBreaks";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

const SED_CLUB_URL = "https://linktr.ee/ShallweData?utm_source=linktree_profile_share&ltsid=26b06437-71f4-4ae1-80ea-5cb148356845";

export function SiteFooterView() {
  const pathname = usePathname();
  const m = useMessages(commonMessages).footer;

  if (pathname.startsWith("/inspector")) {
    return (
      <footer className="site-footer">
        <div className="shell footer-grid">
          <div><Brand /><p className="footer-copy">{m.inspectorCopy}</p></div>
          {/* 다른 탭(소비자 footer)과 같은 배치: 로고를 위에, 동아리 이름을
              그 아래 캡션으로 둔다. 로고 자리 자체는 그대로 오른쪽에 둔다. */}
          <div className="footer-right">
            <Image
              className="footer-club-logo"
              src="/brand/sed-club-logo-white.png"
              alt={m.clubLogoAlt}
              width={240}
              height={240}
            />
            <p className="footer-note">{m.inspectorNote}</p>
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="consumer-footer">
      <div className="shell consumer-footer-grid">
        <div>
          <p>{m.consumerLine1} {m.consumerLine2}</p>
        </div>
        {/* 동아리 로고를 가운데 위에, 이름을 그 아래 가운데 캡션으로 둔다. 로고는 동아리 링크로 연결한다. */}
        <div className="consumer-footer-right">
          <a className="footer-club-link" href={SED_CLUB_URL} target="_blank" rel="noopener noreferrer">
            <Image
              className="footer-club-logo"
              src="/brand/sed-club-logo-white.png"
              alt={m.clubLogoAlt}
              width={240}
              height={240}
            />
          </a>
          <p className="consumer-footer-note">{withMobileBreaks(m.clubName)}</p>
        </div>
      </div>
    </footer>
  );
}
