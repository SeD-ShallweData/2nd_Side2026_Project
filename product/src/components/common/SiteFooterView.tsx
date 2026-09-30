"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/common/SiteHeader";
import { useMessages } from "@/i18n/LocaleProvider";
import { commonMessages } from "@/i18n/messages/common";

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
          <Brand />
          <p>{m.consumerLine1}<br />{m.consumerLine2}</p>
        </div>
        {/* 동아리 로고를 위에, 로고를 설명하는 이름을 그 아래 캡션으로 둔다. */}
        <div className="consumer-footer-right">
          <Image
            className="footer-club-logo"
            src="/brand/sed-club-logo-white.png"
            alt={m.clubLogoAlt}
            width={240}
            height={240}
          />
          <p className="consumer-footer-note">{m.clubName}</p>
        </div>
      </div>
    </footer>
  );
}
