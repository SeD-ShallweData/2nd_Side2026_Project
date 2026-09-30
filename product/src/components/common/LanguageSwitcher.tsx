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
        <span aria-hidden="true">🌐</span>
        <span>{LOCALE_NATIVE_NAMES[locale]}</span>
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
