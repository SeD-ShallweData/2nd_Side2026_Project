"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { format, pickMessages } from "@/i18n/defineMessages";
import { persistLocale, useLocale } from "@/i18n/LocaleProvider";
import { browserLanguages, hasLocaleCookie, suggestLocale } from "@/i18n/localeSuggestion";
import { htmlLang, LOCALE_NATIVE_NAMES, type ImplementedForeignLocale } from "@/i18n/locales";
import { languageMessages } from "@/i18n/messages/language";

/*
 * 처음 온 사용자에게 브라우저 언어로 화면 언어를 제안하는 띠(강요하지 않음).
 * 서버 렌더링에서는 아무것도 그리지 않고, 브라우저에서 쿠키와 언어 목록을 본 뒤에만 나타난다.
 * 문구는 제안하는 언어의 고정 사전으로 보인다(그 언어 사용자가 읽을 수 있게).
 */
export function LocaleSuggestionBanner({
  suggested,
  onAccept,
  onDismiss,
}: {
  suggested: ImplementedForeignLocale;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const m = pickMessages(languageMessages, suggested);
  const language = LOCALE_NATIVE_NAMES[suggested];
  return (
    <aside className="locale-suggestion" role="region" aria-label={m.suggestAria} lang={htmlLang(suggested)}>
      <div className="shell locale-suggestion-inner">
        <p>{format(m.suggestTitle, { language })}</p>
        <div className="locale-suggestion-actions">
          <button type="button" className="button button-dark button-small" onClick={onAccept}>
            {format(m.suggestAccept, { language })}
          </button>
          <button type="button" className="button button-outline button-small" onClick={onDismiss}>
            {m.suggestDismiss}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function LocaleSuggestion() {
  const locale = useLocale();
  const router = useRouter();
  const [suggested, setSuggested] = useState<ImplementedForeignLocale | null>(null);

  useEffect(() => {
    // 쿠키가 없을 때 서버는 언제나 한국어로 그린다. 이미 고른 적이 있으면 묻지 않는다.
    if (locale !== "ko" || hasLocaleCookie(document.cookie)) return;
    // 브라우저 정보를 읽은 뒤에만 띄워야 서버 렌더링과 어긋나지 않는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSuggested(suggestLocale(browserLanguages(navigator)));
  }, [locale]);

  if (!suggested) return null;
  return (
    <LocaleSuggestionBanner
      suggested={suggested}
      onAccept={() => {
        persistLocale(suggested);
        setSuggested(null);
        router.refresh();
      }}
      onDismiss={() => {
        // 한국어를 고른 것으로 기억한다. 다음 방문부터 다시 묻지 않는다.
        persistLocale("ko");
        setSuggested(null);
      }}
    />
  );
}
