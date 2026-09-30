import { format } from "@/i18n/defineMessages";

/*
 * 서버가 보낸 한국어 고정 문장을 화면 언어의 고정 문장으로 바꾼다(언어 지원 3단계).
 *
 * 사전의 한국어 값과 **글자 하나까지 같은** 문장만 바꾼다. {자리표시자}가 있는 문장은
 * 같은 틀인지 맞춰 보고 자리 값을 옮긴다. 맞는 틀이 없으면 null 을 돌려주고, 호출한 쪽은
 * 한국어 원문을 그대로 보인다. 모델을 부르지 않는다.
 */

const PLACEHOLDER = /\{(\w+)\}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "{count}건 확인" 같은 한국어 틀에 문장이 맞으면 자리 값을 돌려준다. */
export function matchTemplate(template: string, text: string): Record<string, string> | null {
  const names: string[] = [];
  let pattern = "";
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    pattern += escapeRegExp(template.slice(last, match.index));
    pattern += "(.+?)";
    names.push(match[1]);
    last = (match.index ?? 0) + match[0].length;
  }
  pattern += escapeRegExp(template.slice(last));
  const found = new RegExp(`^${pattern}$`, "u").exec(text);
  if (!found) return null;
  return Object.fromEntries(names.map((name, index) => [name, found[index + 1]]));
}

export interface FixedTextOptions {
  /** 자리 값을 화면 언어로 바꾼다(예: 항목 이름). null 을 돌려주면 문장 전체를 바꾸지 않는다. */
  translateParam?: (name: string, value: string) => string | null;
  /** 자리 값이 이 모양이어야 한다(예: 건수는 숫자). */
  paramPattern?: Partial<Record<string, RegExp>>;
}

/**
 * 한국어 문장 → 화면 언어 문장. ko·target 은 같은 열쇠를 가진 한 사전의 두 언어다.
 * 자리표시자가 없는 문장을 먼저 비교해, 틀이 더 넓은 문장이 먼저 잡히지 않게 한다.
 */
export function translateFixedText(
  text: string,
  ko: Readonly<Record<string, string>>,
  target: Readonly<Record<string, string>>,
  options: FixedTextOptions = {},
): string | null {
  const keys = Object.keys(ko);
  for (const key of keys) {
    if (!ko[key].includes("{") && ko[key] === text) return target[key] ?? null;
  }
  for (const key of keys) {
    if (!ko[key].includes("{")) continue;
    const params = matchTemplate(ko[key], text);
    if (!params || target[key] === undefined) continue;
    const values: Record<string, string> = {};
    let usable = true;
    for (const [name, value] of Object.entries(params)) {
      const expected = options.paramPattern?.[name];
      if (expected && !expected.test(value)) {
        usable = false;
        break;
      }
      const translated = options.translateParam ? options.translateParam(name, value) : value;
      if (translated === null) {
        usable = false;
        break;
      }
      values[name] = translated;
    }
    if (usable) return format(target[key], values);
  }
  return null;
}
