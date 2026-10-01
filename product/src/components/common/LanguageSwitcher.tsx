"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { persistLocale, useLocale, useMessages } from "@/i18n/LocaleProvider";
import { LOCALES, LOCALE_NATIVE_NAMES, PENDING_LOCALES, type Locale } from "@/i18n/locales";
import { languageMessages } from "@/i18n/messages/language";

/*
 * 화면 언어 선택.
 * 구현한 언어는 누르면 바뀌고, 지원 예정 언어는 비활성으로 두되 커서를 올리거나
 * 눌렀을 때 준비 이유(공식 통계)를 팝업으로 보여 준다. 근거 문구가 없는 언어는 공통 안내만 보인다.
 */
export function LanguageSwitcher() {
  const locale = useLocale();
  const m = useMessages(languageMessages);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  function choose(next: Locale) {
    setOpen(false);
    if (next === locale) return;
    persistLocale(next);
    router.refresh();
  }

  return (
    <div className="language-switcher" ref={rootRef}>
      <button
        type="button"
        className="language-switcher-toggle"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${m.selectorAria}: ${LOCALE_NATIVE_NAMES[locale]}`}
        onClick={() => setOpen((value) => !value)}
      >
        {/* 넓은 화면은 이모지, 좁은 화면은 원 가운데에 정확히 맞는 선 아이콘을 쓴다(이모지는 글꼴마다 중심이 어긋난다). */}
        <span className="lang-globe-emoji" aria-hidden="true">🌐</span>
        <svg className="lang-globe-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9M12 3c-2.6 2.6-3.9 5.6-3.9 9s1.3 6.4 3.9 9" />
          </g>
        </svg>
        <span className="lang-current-name">{LOCALE_NATIVE_NAMES[locale]}</span>
      </button>
      {open ? (
        <div className="language-switcher-menu" id={listId} role="group" aria-label={m.selectorAria}>
          <ul>
            {LOCALES.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  lang={item === "ko-easy" ? "ko" : item}
                  className={item === locale ? "is-current" : undefined}
                  aria-current={item === locale ? "true" : undefined}
                  onClick={() => choose(item)}
                >
                  <strong>{LOCALE_NATIVE_NAMES[item]}</strong>
                  {item === "ko-easy" ? <small>{m.easyKoreanDescription}</small> : null}
                </button>
              </li>
            ))}
          </ul>
          <ul className="language-switcher-pending" aria-label={m.pendingBadge}>
            {PENDING_LOCALES.map((item) => {
              const reason = m.pendingReason[item];
              const tipId = `${listId}-${item}`;
              return (
                <li key={item}>
                  <button type="button" aria-disabled="true" aria-describedby={tipId} lang={item}>
                    <strong>{LOCALE_NATIVE_NAMES[item]}</strong>
                    <small>{m.pendingBadge}</small>
                  </button>
                  <span className="language-pending-tip" role="tooltip" id={tipId}>
                    {reason ? <>{reason} </> : null}
                    {m.pendingCommon}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
