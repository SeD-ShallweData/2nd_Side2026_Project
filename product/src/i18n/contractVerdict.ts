import type { ContractItem, ContractReviewResult } from "@/domain/contract";
import type { MessageShape } from "@/i18n/defineMessages";
import { translateFixedText } from "@/i18n/fixedText";
import { isImplementedForeignLocale, type Locale } from "@/i18n/locales";
import { contractVerdictMessages } from "@/i18n/messages/contractVerdict";

/*
 * 계약서 진단 결과를 화면 언어로 보이게 한다(언어 지원 3단계, 설계 보고서 5.2 D).
 *
 * - 판정 문구는 고정 사전(messages/contractVerdict.ts)만 쓴다. 모델 번역은 쓰지 않는다.
 * - 항목은 규칙 엔진의 코드로 찾는다. 사전에 없는 코드는 한국어 이름·설명을 그대로 보인다.
 * - 숫자·금액이 든 한국어 설명은 번역하지 않고 "한국어 원문"으로 함께 보인다.
 * - 조문명은 한국어로 두고 괄호로 법률 이름만 덧붙인다(인용 검증과 공식 서류 대조를 위해).
 * - 한국어·쉬운 한국어 화면에서는 아무것도 바꾸지 않는다(null).
 * - 상담으로 넘기는 요약(contractReviewContext)은 이 결과가 아니라 서버의 한국어 결과로 만든다.
 */

type VerdictMessages = MessageShape<typeof contractVerdictMessages.ko>;
type ItemEntry = { label: string; about: string };

export interface LocalizedText {
  text: string;
  /** 번역했으면 대조용 한국어 원문. 번역하지 못했으면 null(text 가 이미 한국어). */
  korean: string | null;
}

export interface LocalizedContractItem {
  code: string;
  label: string;
  /** 사전의 "무엇을 보는 항목인지" 한 줄. 사전에 없는 코드면 null. */
  about: string | null;
  /** 서버의 한국어 설명. 번역하지 않는다. */
  korean_description: string;
  korean_label: string;
  legal_basis?: string;
  translated: boolean;
}

export interface LocalizedContractReview {
  detected_items: LocalizedContractItem[];
  missing_items: LocalizedContractItem[];
  review_items: LocalizedContractItem[];
  suggested_questions: LocalizedText[];
  notices: LocalizedText[];
  korean_original_label: string;
}

const LAW_KEYS = [
  "laborStandardsDecree",
  "laborStandards",
  "minimumWageDecree",
  "minimumWage",
  "retirementBenefit",
  "fixedTerm",
  "equalEmployment",
] as const;

function itemEntry(messages: VerdictMessages, code: string): ItemEntry | null {
  const items = messages.items as Record<string, ItemEntry>;
  return Object.prototype.hasOwnProperty.call(items, code) ? items[code] : null;
}

/** "근로기준법 제17조" → "근로기준법 제17조 (Labor Standards Act)". 모르는 법률은 그대로. */
export function localizeLegalBasis(basis: string | undefined, target: VerdictMessages): string | undefined {
  if (!basis) return basis;
  const ko = contractVerdictMessages.ko.laws;
  // 시행령이 법률보다 먼저 오도록 LAW_KEYS 순서를 지킨다.
  for (const key of LAW_KEYS) {
    if (basis.startsWith(ko[key])) return `${basis} (${target.laws[key]})`;
  }
  return basis;
}

function localizeItem(item: ContractItem, target: VerdictMessages): LocalizedContractItem {
  const entry = itemEntry(target, item.code);
  return {
    code: item.code,
    label: entry?.label ?? item.label,
    about: entry?.about ?? null,
    korean_description: item.description,
    korean_label: item.label,
    legal_basis: localizeLegalBasis(item.legal_basis, target),
    translated: entry !== null,
  };
}

function localizeSentence(
  text: string,
  group: "headlines" | "questions" | "notes",
  target: VerdictMessages,
  labelByKorean: Map<string, string>,
): LocalizedText {
  const translated = translateFixedText(
    text,
    contractVerdictMessages.ko[group] as Record<string, string>,
    target[group] as Record<string, string>,
    {
      paramPattern: { violation: /^\d+$/, check: /^\d+$/ },
      // 질문 속 항목 이름은 같은 결과 안의 항목으로만 옮긴다. 모르는 이름이면 문장을 바꾸지 않는다.
      translateParam: (name, value) => (name === "label" ? labelByKorean.get(value) ?? null : value),
    },
  );
  return translated === null ? { text, korean: null } : { text: translated, korean: text };
}

export function localizeContractReview(result: ContractReviewResult, locale: Locale): LocalizedContractReview | null {
  if (!isImplementedForeignLocale(locale)) return null;
  const target = contractVerdictMessages[locale];
  const allItems = [...result.detected_items, ...result.missing_items, ...result.review_items];
  const labelByKorean = new Map<string, string>();
  for (const item of allItems) {
    const entry = itemEntry(target, item.code);
    if (entry && !labelByKorean.has(item.label)) labelByKorean.set(item.label, entry.label);
  }
  return {
    detected_items: result.detected_items.map((item) => localizeItem(item, target)),
    missing_items: result.missing_items.map((item) => localizeItem(item, target)),
    review_items: result.review_items.map((item) => localizeItem(item, target)),
    suggested_questions: result.suggested_questions.map((question) =>
      localizeSentence(question, "questions", target, labelByKorean)),
    notices: [
      ...result.warnings.map((warning) => {
        const headline = localizeSentence(warning, "headlines", target, labelByKorean);
        return headline.korean === null ? localizeSentence(warning, "notes", target, labelByKorean) : headline;
      }),
      ...result.limitations.map((limitation) => localizeSentence(limitation, "notes", target, labelByKorean)),
    ],
    korean_original_label: target.koreanOriginal,
  };
}
