/*
 * 서버 로그에 남길 오류 문구를 정리한다. 화면으로 보내는 문구를 만드는 곳이 아니다.
 *
 * pg·fetch·상류 서비스가 만든 오류 문구에는 접속 문자열, 비밀번호, Bearer 토큰, API 키처럼
 * 로그에도 남기면 안 되는 조각이 섞일 수 있다. 그런 조각을 지우고, 한 줄로 줄여 길이를 자른다.
 * postgres.ts(읽기 실패 기록)와 utils/errors.ts(5xx 기록), 계약서 분석 상류 오류 기록이 함께 쓴다.
 */

const DEFAULT_MAX_LENGTH = 200;
// 정규식이 긴 입력에서 오래 돌지 않도록 앞부분만 본다. 남기는 것은 어차피 앞 200자다.
const MAX_INPUT_LENGTH = 2_000;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // 접속 문자열은 통째로 지운다. 사용자·비밀번호·호스트가 한데 들어 있다.
  [/postgres(?:ql)?:\/\/\S+/gi, "[connection-string]"],
  // 그 밖의 주소도 사용자 정보(user:password@)가 붙어 있으면 지운다.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]*@\S*/gi, "[credential-url]"],
  [/password\s*=\s*\S+/gi, "password=[redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  // api_key=…, "token": "…" 처럼 이름과 값이 붙어 온 경우 값만 지운다.
  [/\b(api[_-]?key|access[_-]?token|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2[redacted]"],
  // OpenAI(sk-…)·Upstage(up_…) 키 모양.
  [/\b(?:sk-|up_)[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  // 글자와 숫자가 섞인 32자 이상의 불투명 문자열(세션 토큰·키). 제약 이름처럼 숫자가 없는 식별자는 남긴다.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, "[redacted-token]"],
];

/*
 * 긴 입력의 앞부분만 남긴다. 자른 자리가 낱말 한가운데면 그 조각은 버린다.
 * 키가 앞 몇 글자만 남으면 아래 규칙(8자·32자 이상)에 걸리지 않는데, 앞쪽 공백이 합쳐지거나
 * 앞의 긴 값이 지워지면 그 조각이 200자 안으로 들어와 그대로 남을 수 있기 때문이다.
 */
function truncateInput(raw: string): string {
  if (raw.length <= MAX_INPUT_LENGTH) return raw;
  const head = raw.slice(0, MAX_INPUT_LENGTH);
  return /\s/.test(raw.charAt(MAX_INPUT_LENGTH)) ? head : head.replace(/\S+$/, "");
}

export function redactErrorText(raw: string, maxLength = DEFAULT_MAX_LENGTH): string {
  let text = truncateInput(raw);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
