/*
 * 현장 제보가 어느 언어로 쓰였는지 추정한다(언어 지원 3단계).
 *
 * 접수 폼(번역 안내를 띄울지)과 서버(번역을 부를지)가 같은 규칙을 써야 한다.
 * 폼이 안내하지 않은 제보를 서버가 모델에 보내면 안 되기 때문이다. 그래서 이 파일은
 * 브라우저·서버 어디서나 불러올 수 있게 순수 함수로만 둔다.
 *
 * 규칙
 *   - 글자 중 한글이 절반 이상이면 한국어다. 번역하지 않는다.
 *   - 화면 언어가 구현 외국어(en·zh·vi·th)면 한글이 절반 미만일 때 번역한다.
 *   - 화면 언어가 한국어여도 한글이 거의 없는(20% 미만) 충분히 긴 글은 번역한다.
 *   - 어느 언어인지는 글자 체계로 정한다: 태국 문자 → th, 한자 → zh,
 *     라틴 문자 → 화면 언어가 en·vi 면 그 언어, 아니면 베트남어 성조 글자가 있으면 vi, 없으면 en.
 *   - 번역 대상이 아닌 글자 체계(키릴 등)는 모델에 보내지 않고 "지원하지 않는 언어"로 둔다.
 */

import {
  isImplementedForeignLocale,
  type ImplementedForeignLocale,
  type Locale,
} from "@/i18n/locales";

export type WorksiteTipLanguage =
  | { kind: "korean" }
  | { kind: "translate"; language: ImplementedForeignLocale }
  /** 번역 경로가 없는 언어. language 는 worksite_tips.source_language 형식(^[a-z]{2,3}$)이다. */
  | { kind: "unsupported"; language: string };

/** 화면 언어가 한국어일 때, 이보다 짧은 글은 외국어로 단정하지 않는다(약어·영문 상호 등). */
const MIN_LETTERS_FOR_KOREAN_LOCALE = 8;
const KOREAN_MAJORITY = 0.5;
const CLEARLY_NON_KOREAN = 0.2;

// tsconfig 대상이 ES2017 이라 유니코드 속성 이스케이프는 리터럴 대신 RegExp 생성자로 만든다.
const LETTER = new RegExp("\\p{L}", "gu");
const HANGUL = new RegExp("\\p{Script=Hangul}", "gu");
const THAI = new RegExp("\\p{Script=Thai}", "gu");
const HAN = new RegExp("\\p{Script=Han}", "gu");
const LATIN = new RegExp("\\p{Script=Latin}", "gu");
const CYRILLIC = new RegExp("\\p{Script=Cyrillic}", "gu");
const DEVANAGARI = new RegExp("\\p{Script=Devanagari}", "gu");
const KHMER = new RegExp("\\p{Script=Khmer}", "gu");
/** 베트남어에만 쓰는 모음·성조 글자. 프랑스어·스페인어와 겹치는 à·é 등은 넣지 않는다. */
const VIETNAMESE_MARKS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function latinLanguage(text: string, locale: Locale): ImplementedForeignLocale {
  if (locale === "en" || locale === "vi") return locale;
  return VIETNAMESE_MARKS.test(text) ? "vi" : "en";
}

export function detectWorksiteTipLanguage(text: string, locale: Locale): WorksiteTipLanguage {
  const normalized = text.normalize("NFC");
  const letters = count(normalized, LETTER);
  if (letters === 0) return { kind: "korean" };
  const hangulRatio = count(normalized, HANGUL) / letters;
  if (hangulRatio >= KOREAN_MAJORITY) return { kind: "korean" };

  const foreignLocale = isImplementedForeignLocale(locale);
  const clearlyNonKorean = hangulRatio < CLEARLY_NON_KOREAN && letters >= MIN_LETTERS_FOR_KOREAN_LOCALE;
  if (!foreignLocale && !clearlyNonKorean) return { kind: "korean" };

  const scripts: Array<[string, number]> = [
    ["th", count(normalized, THAI)],
    ["zh", count(normalized, HAN)],
    ["latin", count(normalized, LATIN)],
    ["ru", count(normalized, CYRILLIC)],
    ["ne", count(normalized, DEVANAGARI)],
    ["km", count(normalized, KHMER)],
  ];
  const [script, size] = scripts.reduce((best, current) => (current[1] > best[1] ? current : best));
  if (size === 0) {
    // 한글도 아니고 아는 글자 체계도 아니다. 화면 언어가 외국어면 그 언어로 본다.
    return foreignLocale ? { kind: "translate", language: locale } : { kind: "unsupported", language: "und" };
  }
  if (script === "th" || script === "zh") return { kind: "translate", language: script };
  if (script === "latin") return { kind: "translate", language: latinLanguage(normalized, locale) };
  return { kind: "unsupported", language: script };
}

/** 제목과 본문을 함께 본다. 폼과 서버가 같은 입력으로 판단하게 한 곳에서 합친다. */
export function detectWorksiteTipSubmissionLanguage(
  title: string,
  body: string | null,
  locale: Locale,
): WorksiteTipLanguage {
  return detectWorksiteTipLanguage(`${title}\n${body ?? ""}`, locale);
}
