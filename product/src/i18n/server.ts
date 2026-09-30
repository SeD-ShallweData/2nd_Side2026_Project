import "server-only";

import { cookies } from "next/headers";
import { pickMessages, type MessageShape, type NamespaceMessages } from "@/i18n/defineMessages";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "@/i18n/locales";

export async function getRequestLocale(): Promise<Locale> {
  try {
    return resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  } catch {
    // 요청 밖(빌드·테스트)에서는 한국어로 그린다.
    return "ko";
  }
}

export async function getMessages<T>(messages: NamespaceMessages<T>): Promise<MessageShape<T>> {
  return pickMessages(messages, await getRequestLocale());
}
