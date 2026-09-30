/*
 * 화면 언어.
 *
 * 화면 문구는 저장소에 고정한 번역 사전(src/i18n/messages)으로만 보여 준다.
 * 상담 모델로 화면 문구를 만들거나 실시간 번역하지 않는다.
 * 번역 품질 검수 상태는 내부 문서(docs/i18n/TRANSLATION_STATUS.md)로만 관리하고 화면에 드러내지 않는다.
 */

export const LOCALES = ["ko", "ko-easy", "en", "zh", "vi", "th"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";
export const LOCALE_COOKIE = "donworry_locale";

/** 선택 목록에 비활성으로만 보이는 언어. 화면·상담 모두 아직 켜지 않는다. */
export const PENDING_LOCALES = ["uz", "ru", "ne", "id", "km"] as const;
export type PendingLocale = (typeof PENDING_LOCALES)[number];

/** 모델 번역(상담·현장 제보)을 켜는 외국어. 한국어·쉬운 한국어는 번역하지 않는다. */
export const IMPLEMENTED_FOREIGN_LOCALES = ["en", "zh", "vi", "th"] as const;
export type ImplementedForeignLocale = (typeof IMPLEMENTED_FOREIGN_LOCALES)[number];

export function isImplementedForeignLocale(value: unknown): value is ImplementedForeignLocale {
  return typeof value === "string" && (IMPLEMENTED_FOREIGN_LOCALES as readonly string[]).includes(value);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** 각 언어로 적은 언어 이름. 선택 목록에서 사용자가 자기 언어를 알아볼 수 있게 한다. */
export const LOCALE_NATIVE_NAMES: Record<Locale | PendingLocale, string> = {
  ko: "한국어",
  "ko-easy": "쉬운 한국어",
  en: "English",
  zh: "中文(简体)",
  vi: "Tiếng Việt",
  th: "ไทย",
  uz: "Oʻzbekcha",
  ru: "Русский",
  ne: "नेपाली",
  id: "Bahasa Indonesia",
  km: "ភាសាខ្មែរ",
};

/** <html lang> 값. 쉬운 한국어도 한국어다. */
export function htmlLang(locale: Locale): string {
  if (locale === "ko-easy") return "ko";
  if (locale === "zh") return "zh-Hans";
  return locale;
}
