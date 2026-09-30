/*
 * 글의 "작성 언어"를 글자 체계로 추정한다(언어 지원 3단계, 설계 보고서 5.2 G — 커뮤니티).
 *
 * 커뮤니티 글은 자동 번역하지 않는다. 대신 작성 언어를 표시하고 언어별로 거를 수 있게 한다.
 * DB에 언어 열을 두지 않으므로(마이그레이션 없음) 같은 규칙을 두 곳에서 계산한다.
 *   - 화면 표시: 이 파일의 detectTextLanguage (서버가 응답 DTO에 넣는다)
 *   - 언어 필터: RealCommunityRepository 의 SQL (textLanguageSql)
 * 두 계산이 어긋나면 "베트남어로 거른 목록에 English 글"이 섞인다. 그래서 글자 범위는 아래
 * 문자열 하나를 JS 정규식과 PostgreSQL 정규식이 함께 쓰고, 비교는 정수 곱셈으로만 한다(소수 오차 없음).
 *
 * 규칙(title + "\n" + body 기준)
 *   1. 한글·태국 문자·한자·가나·라틴 문자를 센다. 모두 0이면 other(키릴·데바나가리·이모지만 있는 글 등).
 *   2. 한글이 30% 이상이면 ko. 한글은 한 글자가 한 음절이라 영문이 섞인 한국어 글도 한국어로 본다.
 *   3. 나머지는 가장 많은 글자 체계로 정한다(같으면 태국 → 한자 → 가나 → 라틴 순).
 *      태국 문자 → th, 한자 → zh, 가나 → other(일본어는 아직 지원하지 않는다),
 *      라틴 → 베트남어 전용 글자(ă đ ơ ư, 성조가 붙은 모음)가 라틴 글자의 5% 이상이면 vi, 아니면 en.
 * 스페인어·인도네시아어처럼 베트남어 글자가 없는 라틴 문자 글은 en 으로 묶인다(추정의 한계).
 */

export const TEXT_LANGUAGES = ["ko", "en", "zh", "vi", "th", "other"] as const;
export type TextLanguage = (typeof TEXT_LANGUAGES)[number];

export function isTextLanguage(value: unknown): value is TextLanguage {
  return typeof value === "string" && (TEXT_LANGUAGES as readonly string[]).includes(value);
}

/** 정규식 대괄호 안에 그대로 넣는 글자 범위. JS(u 플래그)와 PostgreSQL 정규식이 같은 뜻으로 읽는다. */
export const SCRIPT_CLASSES = {
  hangul: "가-힣ᄀ-ᇿㄱ-ㆎ",
  thai: "฀-๿",
  han: "一-鿿㐀-䶿",
  kana: "぀-ヿ",
  latin: "A-Za-zÀ-ÖØ-öø-ɏḀ-ỿ",
  /** 베트남어에만 쓰는 글자: ă đ ơ ư 와 성조가 붙은 모음(라틴 확장 추가 영역 U+1EA0–U+1EF9). */
  vietnamese: "ăđơưĂĐƠƯẠ-ỹ",
} as const;

type ScriptName = keyof typeof SCRIPT_CLASSES;

const PATTERNS = Object.fromEntries(
  Object.entries(SCRIPT_CLASSES).map(([name, chars]) => [name, new RegExp(`[${chars}]`, "gu")]),
) as Record<ScriptName, RegExp>;

function count(text: string, script: ScriptName): number {
  return text.match(PATTERNS[script])?.length ?? 0;
}

export interface ScriptCounts {
  hangul: number;
  thai: number;
  han: number;
  kana: number;
  latin: number;
  vietnamese: number;
}

export function countScripts(text: string): ScriptCounts {
  return {
    hangul: count(text, "hangul"),
    thai: count(text, "thai"),
    han: count(text, "han"),
    kana: count(text, "kana"),
    latin: count(text, "latin"),
    vietnamese: count(text, "vietnamese"),
  };
}

/** 규칙 본체. SQL(textLanguageSql)과 줄마다 대응한다. */
export function languageFromCounts({ hangul, thai, han, kana, latin, vietnamese }: ScriptCounts): TextLanguage {
  const total = hangul + thai + han + kana + latin;
  if (total === 0) return "other";
  if (hangul * 10 >= total * 3) return "ko";
  if (thai >= han && thai >= kana && thai >= latin) return "th";
  if (han >= kana && han >= latin) return "zh";
  if (kana >= latin) return "other";
  return vietnamese * 20 >= latin ? "vi" : "en";
}

export function detectTextLanguage(text: string): TextLanguage {
  return languageFromCounts(countScripts(text));
}

/** 커뮤니티 글의 작성 언어. 제목과 본문을 함께 본다. */
export function detectPostLanguage(title: string, body: string): TextLanguage {
  return detectTextLanguage(`${title}\n${body}`);
}
