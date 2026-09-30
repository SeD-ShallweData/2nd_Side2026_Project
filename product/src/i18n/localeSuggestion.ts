import {
  IMPLEMENTED_FOREIGN_LOCALES,
  LOCALE_COOKIE,
  PENDING_LOCALES,
  type ImplementedForeignLocale,
} from "@/i18n/locales";

/*
 * 처음 온 사용자에게 화면 언어를 제안한다(언어 지원 0단계 남은 과제, 설계 보고서 5.2 A).
 *
 * - 제안만 한다. 언어를 바꾸는 것은 사용자가 "…로 보기"를 눌렀을 때뿐이다.
 * - 언어 쿠키(donworry_locale)가 이미 있으면 제안하지 않는다. 사용자가 고른 적이 있다는 뜻이다.
 * - "한국어로 계속"을 누르면 쿠키에 ko 를 남겨 다시 묻지 않는다(선택을 기억한다).
 * - 브라우저 언어 목록(navigator.languages, Accept-Language 와 같은 순서)을 앞에서부터 본다.
 *     한국어가 먼저 나오면 제안하지 않는다.
 *     구현 외국어(en·zh·vi·th)가 먼저 나오면 그 언어를 제안한다.
 *     지원 예정 언어(uz·ru·ne·id·km)는 영어를 제안한다("지금은 영어로 이용할 수 있습니다").
 *     그 밖의 언어뿐이면(예: 일본어·프랑스어) 영어를 제안한다.
 * 쉬운 한국어는 나이·체류자격을 추정해 제안하지 않는다(누구나 직접 고른다).
 */

function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function suggestLocale(browserLanguages: readonly string[]): ImplementedForeignLocale | null {
  const tags = browserLanguages.map(primarySubtag).filter(Boolean);
  if (tags.length === 0) return null;
  for (const tag of tags) {
    if (tag === "ko") return null;
    if ((IMPLEMENTED_FOREIGN_LOCALES as readonly string[]).includes(tag)) return tag as ImplementedForeignLocale;
    if ((PENDING_LOCALES as readonly string[]).includes(tag)) return "en";
  }
  return "en";
}

/** document.cookie 에 화면 언어 쿠키가 있는가. 값이 비어 있어도 고른 적이 있는 것으로 본다. */
export function hasLocaleCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.split("=")[0]?.trim() === LOCALE_COOKIE);
}

/** 브라우저가 알려 준 언어 목록. navigator.languages 가 없으면 navigator.language 하나만 쓴다. */
export function browserLanguages(nav: Pick<Navigator, "language"> & { languages?: readonly string[] }): string[] {
  if (nav.languages && nav.languages.length > 0) return [...nav.languages];
  return nav.language ? [nav.language] : [];
}
