import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/common/SiteFooter";
import { SiteHeader } from "@/components/common/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "돈워리 — 일하기 전, 일하는 중에도",
    template: "%s | 돈워리",
  },
  description:
    "공공데이터 기반 고용 신호와 공식 노동 정보를 연결해 입사 전과 재직 중 확인할 정보를 안내합니다.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <a className="skip-link" href="#main-content">
          본문으로 바로가기
        </a>
        <SiteHeader />
        <main id="main-content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
