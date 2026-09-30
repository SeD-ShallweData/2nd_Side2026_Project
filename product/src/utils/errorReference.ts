/*
 * 화면 오류 경계에 보여 줄 문의 코드.
 *
 * Next 는 서버에서 난 렌더링 오류마다 digest(해시)를 만들어 서버 로그에 함께 남기고,
 * 화면에는 digest 만 넘긴다. 사용자가 이 코드를 알려 주면 같은 digest 로 로그를 찾는다.
 * 모양이 이상한 값은 보여 주지 않고, 읽어 주기 쉽도록 앞부분만 쓴다.
 *
 * Next 는 자기 내부 오류의 digest 에 오류 번호를 덧붙여 '<해시>@E<번호>' 로 만든다
 * (next/dist/lib/error-telemetry-utils.js 의 createDigestWithErrorCode). '@' 앞의 해시만 쓴다.
 * 로그에 남은 digest 도 같은 해시로 시작하므로 앞부분으로 찾을 수 있다.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REFERENCE_LENGTH = 12;
const NEXT_ERROR_CODE_DELIMITER = "@";

export function errorReferenceCode(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const hash = digest.split(NEXT_ERROR_CODE_DELIMITER, 1)[0] ?? "";
  if (!REFERENCE_PATTERN.test(hash)) return null;
  return hash.slice(0, REFERENCE_LENGTH);
}

/*
 * 오류 경계가 받는 값은 Error 가 아닐 수도 있다(throw null, 문자열 등 — Next 도 보장하지 않는다).
 * 대체 화면 자체가 다시 터지지 않도록 digest 를 조심해서 꺼낸다.
 */
export function errorReferenceCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  return errorReferenceCode((error as { digest?: unknown }).digest);
}
