import { translateFixedText } from "@/i18n/fixedText";
import { isImplementedForeignLocale, type Locale } from "@/i18n/locales";
import { companyRiskMessages } from "@/i18n/messages/companyRisk";

/*
 * 사업장 확인 카드의 서버 한국어 문장을 화면 언어의 고정 문장으로 바꾼다(설계 보고서 5.2 F).
 * 사전(messages/companyRisk.ts)에 글자까지 같은 문장이 없으면 한국어를 그대로 돌려준다.
 * 한국어·쉬운 한국어 화면에서는 언제나 입력을 그대로 돌려준다. 모델을 부르지 않는다.
 */

const KO = companyRiskMessages.ko;

function lookup(group: Readonly<Record<string, string>>, target: Readonly<Record<string, string>>, value: string): string | null {
  for (const [key, text] of Object.entries(group)) {
    if (text === value) return target[key] ?? null;
  }
  return null;
}

export function translateRiskText(text: string, locale: Locale): string {
  if (!isImplementedForeignLocale(locale) || !text) return text;
  const target = companyRiskMessages[locale];
  return translateFixedText(text, KO.texts, target.texts, {
    paramPattern: { count: /^\d+$/ },
    // 우선순위 구간과 기간 안내도 사전에 있는 값만 옮긴다. 모르는 값이면 문장 전체를 한국어로 둔다.
    translateParam: (name, value) => {
      if (name === "band") return lookup(KO.bands, target.bands, value);
      if (name === "note") return lookup(KO.notes, target.notes, value);
      return value;
    },
  }) ?? text;
}
