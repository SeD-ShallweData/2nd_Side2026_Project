import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/common/SiteFooter";
import { LocaleSuggestion } from "@/components/common/LocaleSuggestion";
import { SiteHeader } from "@/components/common/SiteHeader";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { htmlLang } from "@/i18n/locales";
import { headerMessages } from "@/i18n/messages/header";
import { siteMessages } from "@/i18n/messages/site";
import { getMessages, getRequestLocale } from "@/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(siteMessages);
  return {
    title: { default: m.title, template: m.titleTemplate },
    description: m.description,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 화면 언어는 쿠키로만 정한다. 화면 문구는 고정 사전이며 상담 모델을 부르지 않는다.
  const locale = await getRequestLocale();
  const header = await getMessages(headerMessages);
  return (
    <html lang={htmlLang(locale)} data-locale={locale}>
      <body>
        <LocaleProvider locale={locale}>
          <a className="skip-link" href="#main-content">
            {header.skipLink}
          </a>
          <SiteHeader />
          <LocaleSuggestion />
          <main id="main-content">{children}</main>
          <SiteFooter />
        </LocaleProvider>
      </body>
    </html>
  );
}
