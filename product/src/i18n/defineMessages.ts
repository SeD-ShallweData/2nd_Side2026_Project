import type { Locale } from "@/i18n/locales";

/** 한국어 사전의 모양을 그대로 따르되 값은 문자열이다. */
export type MessageShape<T> = { [K in keyof T]: T[K] extends string ? string : MessageShape<T[K]> };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

export interface NamespaceMessages<T> {
  ko: T;
  /** 쉬운 한국어. 적지 않은 항목은 한국어를 그대로 쓴다. */
  "ko-easy": DeepPartial<MessageShape<T>>;
  en: MessageShape<T>;
  zh: MessageShape<T>;
  vi: MessageShape<T>;
  th: MessageShape<T>;
}

/**
 * 한 화면 묶음(namespace)의 번역 사전을 정의한다.
 * 영어·중국어·베트남어·태국어는 한국어와 키가 모두 같아야 타입 검사를 통과한다.
 */
export function defineMessages<const T extends Record<string, unknown>>(messages: NamespaceMessages<T>): NamespaceMessages<T> {
  return messages;
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object") return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = result[key];
    result[key] = current && typeof current === "object" && value && typeof value === "object"
      ? mergeDeep(current, value)
      : value ?? current;
  }
  return result as T;
}

/** 현재 언어의 사전. 쉬운 한국어는 한국어 위에 덮어쓴다. */
export function pickMessages<T>(messages: NamespaceMessages<T>, locale: Locale): MessageShape<T> {
  if (locale === "ko") return messages.ko as MessageShape<T>;
  if (locale === "ko-easy") return mergeDeep(messages.ko as MessageShape<T>, messages["ko-easy"]);
  return messages[locale];
}

/** "{count}개" 같은 자리표시자를 채운다. 사전에는 함수 대신 자리표시자만 둔다. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
