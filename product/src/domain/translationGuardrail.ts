/*
 * 번역 보존 검사(언어 지원 2단계).
 *
 * 상담 답변은 한국어로 먼저 만들고 17개 출력 가드레일·인용 검증을 거친 뒤 번역한다.
 * 그래서 번역 단계에서 새로 생길 수 있는 문제만 본다.
 *
 * - 숫자·전화번호·금액·기간이 빠지거나 바뀌지 않았는가
 * - 조문 인용(「근로기준법」 제43조)과 기관명(고용노동부 등)이 한국어 원문 그대로 남았는가
 *   (뒤에 괄호로 번역 풀이를 붙이는 것은 허용한다)
 * - 한국어 답변에 없던 판정·단정 표현(위법·illegal·safe·definitely …)이 번역에서 새로 생기지 않았는가
 *
 * 모델을 부르지 않는 순수 함수다. 실패하면 호출한 쪽이 한국어 원문으로 대체한다.
 */

import type { ImplementedForeignLocale } from "@/i18n/locales";

export type TranslationLanguage = "ko" | ImplementedForeignLocale;

export type TranslationGuardrailFailure =
  | "EMPTY"
  | "LENGTH_OUT_OF_RANGE"
  | "UNTRANSLATED"
  | "NUMBER_MISSING"
  | "NUMBER_ADDED"
  | "PHONE_MISSING"
  | "CURRENCY_MISSING"
  | "CITATION_MISSING"
  | "ORGANIZATION_MISSING"
  | "VERDICT_ADDED";

export interface TranslationGuardrailInput {
  source: string;
  translation: string;
  from: TranslationLanguage;
  to: TranslationLanguage;
}

export interface TranslationGuardrailResult {
  ok: boolean;
  failures: TranslationGuardrailFailure[];
  /** 어떤 값이 빠졌거나 더해졌는지. 운영 추적용이며 화면에 보이지 않는다. */
  details: string[];
}

/** 번역문에 한국어 원문 그대로 남아야 하는 기관명. 긴 이름을 먼저 둔다. */
export const PRESERVED_ORGANIZATIONS = [
  "한국산업안전보건공단",
  "대한법률구조공단",
  "외국인력상담센터",
  "외국인노동자지원센터",
  "외국인근로자지원센터",
  "한국산업인력공단",
  "출입국·외국인청",
  "출입국외국인청",
  "국민권익위원회",
  "지방고용노동청",
  "근로복지공단",
  "안전보건공단",
  "노동위원회",
  "고용노동부",
  "법률홈닷컴",
  "고용센터",
] as const;

/** 조문 인용. 적재 여부와 관계없이 "…법 제N조(의M)" 꼴을 모두 본다. */
const CITATION_SOURCE =
  "(?:「\\s*)?[가-힣ㆍ]{2,20}법(?:률)?(?:\\s*시행령|\\s*시행규칙)?(?:\\s*」)?\\s*제\\s*\\d+\\s*조(?:의\\s*\\d+)?";

/** 지역번호가 있는 전화번호(02-1234-5678, 1644-0644 는 숫자 검사로 본다). */
const PHONE_SOURCE = "(?<!\\d)\\d{2,4}-\\d{3,4}-\\d{4}(?!\\d)";

const CURRENCY_BY_LANGUAGE: Record<TranslationLanguage, RegExp> = {
  ko: /원/,
  en: /\bwon\b|KRW|₩/i,
  zh: /韩元|韓元|韩币|韩圆|KRW|₩|won/i,
  vi: /\bwon\b|KRW|₩/i,
  th: /วอน|KRW|₩|won/i,
};

/** 원문에 금액이 있는지. 한국어는 "…원", 외국어는 각 언어의 통화 표기. */
const AMOUNT_BY_LANGUAGE: Record<TranslationLanguage, RegExp> = {
  ko: /\d[\d,]*\s*(?:천만|만|억|천)?\s*원/,
  en: /\d[\d,.]*\s*(?:won\b|KRW)|(?:₩|KRW)\s*\d/i,
  zh: /\d[\d,.]*\s*(?:万|亿)?\s*(?:韩元|韓元|韩币)|(?:₩|KRW)\s*\d/i,
  vi: /\d[\d,.]*\s*(?:won\b|KRW)|(?:₩|KRW)\s*\d/i,
  th: /\d[\d,.]*\s*(?:วอน|KRW)|(?:₩|KRW)\s*\d/i,
};

type VerdictCategory = "legal" | "safety" | "certainty" | "outcome";

/*
 * 판정·단정 표현. 한 언어에만 있고 다른 언어에는 없는 범주가 번역문에 생기면 실패다.
 * 부정문("위법 여부를 단정하지 않습니다")도 범주가 양쪽에 함께 있으므로 통과한다.
 * 베트남어는 성조 표시를 지운 글자로 본다.
 */
const VERDICT_PATTERNS: Record<TranslationLanguage, Record<VerdictCategory, RegExp>> = {
  ko: {
    legal: /위법|불법|위반|적법|합법/,
    safety: /안전|위험/,
    certainty: /반드시|확실|틀림없|분명|무조건|꼭|100\s*%/,
    outcome: /승소|패소|처벌|벌금|과태료/,
  },
  en: {
    legal: /\b(?:illegal(?:ly)?|unlawful(?:ly)?|lawful(?:ly)?|violat(?:e|es|ed|ing|ion|ions)|against the law|breach(?:es|ed)? of (?:the )?law)\b/i,
    safety: /\b(?:safe(?:ly|ty)?|unsafe|danger(?:ous)?|risk(?:y|s)?)\b/i,
    certainty: /\b(?:definitely|certainly|surely|guarantee(?:d|s)?|undoubtedly|absolutely|without (?:a )?doubt)\b|100\s*%/i,
    outcome: /\b(?:win (?:the|your) case|lose (?:the|your) case|punish(?:ed|ment)?|fined?|penalt(?:y|ies))\b/i,
  },
  zh: {
    legal: /违法|非法|不合法|合法|违反/,
    safety: /安全|危险|风险/,
    certainty: /一定|肯定|必然|绝对|保证|毫无疑问|百分之百|100\s*%/,
    outcome: /胜诉|败诉|处罚|惩罚|罚款|罚金/,
  },
  vi: {
    legal: /bat hop phap|trai phap luat|vi pham|hop phap/,
    safety: /an toan|nguy hiem|rui ro/,
    certainty: /tuyet doi|nhat dinh|chac chan se|100\s*%/,
    outcome: /thang kien|thua kien|bi phat|xu phat|tien phat/,
  },
  th: {
    legal: /ผิดกฎหมาย|ไม่ชอบด้วยกฎหมาย|ละเมิด|ถูกกฎหมาย|ชอบด้วยกฎหมาย/,
    safety: /ปลอดภัย|อันตราย|เสี่ยง/,
    certainty: /แน่นอน|รับประกัน|ร้อยเปอร์เซ็นต์|100\s*%/,
    outcome: /ชนะคดี|แพ้คดี|ลงโทษ|ถูกปรับ|ค่าปรับ/,
  },
};

const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const EN_MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const TH_MONTH_ABBR = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** 원문에 글자로 적힌 수. 번역문이 이 수를 숫자로 적어도 "더한 숫자"로 보지 않는다. */
const NUMBER_WORDS: Record<TranslationLanguage, Array<[RegExp, number[]]>> = {
  ko: [
    [/(?:^|[^가-힣])한\s*(?:번|달|명|개|시간|주|차례|가지|곳|장|해|날|사람)/, [1]],
    [/(?:^|[^가-힣])두\s*(?:번|달|명|개|시간|주|차례|가지|곳|장|해|날|사람)/, [2]],
    [/(?:^|[^가-힣])세\s*(?:번|달|명|개|시간|주|차례|가지|곳|장|해|날|사람)/, [3]],
    [/(?:^|[^가-힣])네\s*(?:번|달|명|개|시간|주|차례|가지|곳|장|해|날|사람)/, [4]],
    [/다섯/, [5]], [/여섯/, [6]], [/일곱/, [7]], [/여덟/, [8]], [/아홉/, [9]],
    [/(?:^|[^가-힣])열\s*(?:번|달|명|개|시간|주|차례|가지|곳|장|해|날|사람)/, [10]],
    [/하루/, [1]], [/이틀/, [2]], [/사흘/, [3]], [/나흘/, [4]], [/일주일/, [1, 7]], [/첫/, [1]],
    [/매월|매달|월\s*1\s*회/, [1]], [/1년|일\s*년/, [1, 12]],
  ],
  en: [
    [/\b(?:one|once|first|a single)\b/i, [1]], [/\b(?:two|twice|second)\b/i, [2]], [/\b(?:three|third)\b/i, [3]],
    [/\b(?:four|fourth)\b/i, [4]], [/\b(?:five|fifth)\b/i, [5]], [/\bsix(?:th)?\b/i, [6]], [/\bseven(?:th)?\b/i, [7]],
    [/\beight(?:h)?\b/i, [8]], [/\bnin(?:e|th)\b/i, [9]], [/\bten(?:th)?\b/i, [10]], [/\btwelve\b/i, [12]],
  ],
  zh: [[/一/, [1]], [/[二两]/, [2]], [/三/, [3]], [/四/, [4]], [/五/, [5]], [/六/, [6]], [/七/, [7]], [/八/, [8]], [/九/, [9]], [/十/, [10]]],
  vi: [
    [/\bmot\b/, [1]], [/\bhai\b/, [2]], [/\bba\b/, [3]], [/\bbon\b/, [4]], [/\bnam\b/, [5]], [/\bsau\b/, [6]],
    [/\bbay\b/, [7]], [/\btam\b/, [8]], [/\bchin\b/, [9]], [/\bmuoi\b/, [10]],
  ],
  th: [
    [/หนึ่ง/, [1]], [/สอง/, [2]], [/สาม/, [3]], [/สี่/, [4]], [/ห้า/, [5]], [/หก/, [6]],
    [/เจ็ด/, [7]], [/แปด/, [8]], [/เก้า/, [9]], [/สิบ/, [10]],
  ],
};

function stripVietnameseMarks(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/** 비교용 정규화: 전각 숫자·태국 숫자를 아라비아 숫자로, 월 이름을 숫자로 바꾼다. */
function normalizeForNumbers(text: string, language: TranslationLanguage): string {
  let value = text.normalize("NFKC").replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  // 목록 번호(1. 2) 등)는 문장 구조일 뿐 내용 숫자가 아니다.
  value = value.replace(/^[ \t]*(?:[-*•]\s*)?\d{1,2}[.)](?=\s)/gm, " ");
  if (language === "en") {
    // "may"는 조동사이기도 해서 대문자로 시작하고 숫자와 붙어 있을 때만 달로 본다.
    value = value.replace(/\b([A-Za-z]+)\.?(?=\s*\d)|(?<=\d\s*)\b([A-Za-z]+)\b/g, (word, before: string | undefined, after: string | undefined) => {
      const name = (before ?? after ?? "").toLowerCase();
      const capitalized = /^[A-Z]/.test(before ?? after ?? "");
      const full = EN_MONTHS.indexOf(name);
      if (full >= 0 && (name !== "may" || capitalized)) return ` ${full + 1} `;
      const abbr = EN_MONTH_ABBR.indexOf(name);
      if (abbr >= 0 && capitalized && name !== "may") return ` ${abbr + 1} `;
      return word;
    });
    value = value.replace(/\b(January|February|March|April|June|July|August|September|October|November|December)\b/gi, (name) => ` ${EN_MONTHS.indexOf(name.toLowerCase()) + 1} `);
  }
  if (language === "th") {
    TH_MONTHS.forEach((name, index) => { value = value.split(name).join(` ${index + 1} `); });
    TH_MONTH_ABBR.forEach((name, index) => { value = value.split(name).join(` ${index + 1} `); });
  }
  return value;
}

function canonicalNumber(token: string): string {
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(token) ? token.replace(/[.,]/g, "") : token.replace(/,/g, "");
  const [integer, fraction] = grouped.split(".");
  const trimmed = integer.replace(/^0+(?=\d)/, "");
  return fraction && /[1-9]/.test(fraction) ? `${trimmed}.${fraction.replace(/0+$/, "")}` : trimmed;
}

function numberTokens(text: string, language: TranslationLanguage): string[] {
  return (normalizeForNumbers(text, language).match(/\d+(?:[.,]\d+)*/g) ?? []).map(canonicalNumber);
}

/** 한국어 금액 단위(만·억·천)를 풀어 쓴 값도 같은 숫자로 인정한다. "100만 원" = "1,000,000 won". */
function koreanUnitExpansions(text: string): Map<string, string[]> {
  const expansions = new Map<string, string[]>();
  const units: Record<string, number> = { 천: 1_000, 만: 10_000, 천만: 10_000_000, 억: 100_000_000 };
  for (const match of text.normalize("NFKC").matchAll(/(\d+(?:[.,]\d+)*)\s*(천만|천|만|억)/g)) {
    const base = canonicalNumber(match[1]);
    const value = Number(base) * units[match[2]];
    if (!Number.isFinite(value)) continue;
    const list = expansions.get(base) ?? [];
    list.push(String(Math.round(value)));
    expansions.set(base, list);
  }
  return expansions;
}

function wordNumbers(text: string, language: TranslationLanguage): Set<string> {
  const target = language === "vi" ? stripVietnameseMarks(text.toLowerCase()) : text;
  const values = new Set<string>();
  for (const [pattern, numbers] of NUMBER_WORDS[language]) {
    if (pattern.test(target)) numbers.forEach((number) => values.add(String(number)));
  }
  return values;
}

function compact(text: string): string {
  return text.normalize("NFKC").replace(/[「」『』《》\s]/g, "");
}

function citationKeys(text: string): string[] {
  return [...new Set((text.normalize("NFKC").match(new RegExp(CITATION_SOURCE, "g")) ?? []).map(compact))];
}

function verdictCategories(text: string, language: TranslationLanguage): Set<VerdictCategory> {
  const target = language === "vi" ? stripVietnameseMarks(text.toLowerCase()) : text;
  const found = new Set<VerdictCategory>();
  for (const [category, pattern] of Object.entries(VERDICT_PATTERNS[language]) as Array<[VerdictCategory, RegExp]>) {
    if (pattern.test(target)) found.add(category);
  }
  return found;
}

function letterCounts(text: string): { hangul: number; letters: number } {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const letters = (text.match(/[A-Za-zÀ-ỹ一-鿿฀-๿가-힣]/g) ?? []).length;
  return { hangul, letters };
}

/** 한국어 원문 기관명·조문을 빼고 남은 글자 중 한글 비율. 번역하지 않고 그대로 돌려준 답을 거른다. */
function untranslated(translation: string, to: TranslationLanguage): boolean {
  if (to === "ko") return letterCounts(translation).hangul === 0;
  let rest = translation.normalize("NFKC").replace(new RegExp(CITATION_SOURCE, "g"), " ");
  for (const name of PRESERVED_ORGANIZATIONS) rest = rest.split(name).join(" ");
  const counts = letterCounts(rest);
  return counts.letters > 0 && counts.hangul / counts.letters > 0.4;
}

/**
 * 원문과 번역문을 비교한다. 한국어 → 외국어(상담 답변)는 조문·기관명까지,
 * 외국어 → 한국어(질문·현장 제보)는 숫자·전화번호·금액·단정 표현만 본다.
 */
export function checkTranslationPreservation(input: TranslationGuardrailInput): TranslationGuardrailResult {
  const source = input.source.trim();
  const translation = input.translation.trim();
  const failures = new Set<TranslationGuardrailFailure>();
  const details: string[] = [];

  if (!translation) return { ok: false, failures: ["EMPTY"], details: [] };
  // 중국어는 짧고 태국어·베트남어는 길다. 크게 벗어날 때만 본다.
  if (source.length >= 20 && (translation.length < source.length * 0.2 || translation.length > source.length * 6)) {
    failures.add("LENGTH_OUT_OF_RANGE");
  }
  if (untranslated(translation, input.to)) failures.add("UNTRANSLATED");

  // 숫자: 원문 숫자는 모두 남아야 하고, 번역문에 원문에 없던 숫자가 생기면 안 된다.
  const sourceNumbers = numberTokens(source, input.from);
  const translatedNumbers = new Set(numberTokens(translation, input.to));
  // 한국어 번역문은 "150만 원"처럼 단위를 섞어 쓸 수 있다. 풀어 쓴 값도 함께 본다.
  if (input.to === "ko") for (const values of koreanUnitExpansions(translation).values()) values.forEach((value) => translatedNumbers.add(value));
  const expansions = input.from === "ko" ? koreanUnitExpansions(source) : new Map<string, string[]>();
  for (const number of new Set(sourceNumbers)) {
    const alternatives = [number, ...(expansions.get(number) ?? [])];
    if (!alternatives.some((candidate) => translatedNumbers.has(candidate))) {
      failures.add("NUMBER_MISSING");
      details.push(`number_missing:${number}`);
    }
  }
  const allowed = new Set([...sourceNumbers, ...[...expansions.values()].flat(), ...wordNumbers(source, input.from)]);
  if (input.to === "ko") {
    // 한국어 번역문의 "만·억" 표기는 원문 숫자와 같은 값일 수 있다.
    for (const [base, values] of koreanUnitExpansions(translation)) {
      if (values.some((value) => allowed.has(value)) || allowed.has(base)) [base, ...values].forEach((value) => allowed.add(value));
    }
  }
  for (const number of translatedNumbers) {
    if (!allowed.has(number)) {
      failures.add("NUMBER_ADDED");
      details.push(`number_added:${number}`);
    }
  }

  for (const phone of source.normalize("NFKC").match(new RegExp(PHONE_SOURCE, "g")) ?? []) {
    if (!translation.normalize("NFKC").includes(phone)) {
      failures.add("PHONE_MISSING");
      details.push(`phone_missing:${phone}`);
    }
  }

  if (AMOUNT_BY_LANGUAGE[input.from].test(source) && !CURRENCY_BY_LANGUAGE[input.to].test(translation)) {
    failures.add("CURRENCY_MISSING");
  }

  if (input.from === "ko") {
    const translatedCompact = compact(translation);
    for (const key of citationKeys(source)) {
      if (!translatedCompact.includes(key)) {
        failures.add("CITATION_MISSING");
        details.push(`citation_missing:${key}`);
      }
    }
    let remaining = source;
    for (const name of PRESERVED_ORGANIZATIONS) {
      if (!remaining.includes(name)) continue;
      remaining = remaining.split(name).join(" ");
      if (!translation.includes(name)) {
        failures.add("ORGANIZATION_MISSING");
        details.push(`organization_missing:${name}`);
      }
    }
  }

  const sourceVerdicts = verdictCategories(source, input.from);
  for (const category of verdictCategories(translation, input.to)) {
    if (!sourceVerdicts.has(category)) {
      failures.add("VERDICT_ADDED");
      details.push(`verdict_added:${category}`);
    }
  }

  return { ok: failures.size === 0, failures: [...failures], details };
}
