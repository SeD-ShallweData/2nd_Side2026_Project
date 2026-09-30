"use client";

import { createContext, useContext, type ReactNode } from "react";
import { pickMessages, type MessageShape, type NamespaceMessages } from "@/i18n/defineMessages";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "@/i18n/locales";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** 공급자 밖(테스트 등)에서는 한국어가 된다. */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useMessages<T>(messages: NamespaceMessages<T>): MessageShape<T> {
  return pickMessages(messages, useLocale());
}

/** 언어 선택을 1년간 기억한다. 서버가 다음 요청부터 같은 언어로 그린다. */
export function persistLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}
