/*
 * 화면 오류 경계에 보여 줄 문의 코드.
 *
 * Next 는 서버에서 난 렌더링 오류마다 digest(해시)를 만들어 서버 로그에 함께 남기고,
 * 화면에는 digest 만 넘긴다. 사용자가 이 코드를 알려 주면 같은 digest 로 로그를 찾는다.
 * 모양이 이상한 값은 보여 주지 않고, 읽어 주기 쉽도록 앞부분만 쓴다.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REFERENCE_LENGTH = 12;

export function errorReferenceCode(digest: unknown): string | null {
  if (typeof digest !== "string" || !REFERENCE_PATTERN.test(digest)) return null;
  return digest.slice(0, REFERENCE_LENGTH);
}

/*
 * 오류 경계가 받는 값은 Error 가 아닐 수도 있다(throw null, 문자열 등 — Next 도 보장하지 않는다).
 * 대체 화면 자체가 다시 터지지 않도록 digest 를 조심해서 꺼낸다.
 */
export function errorReferenceCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  return errorReferenceCode((error as { digest?: unknown }).digest);
}
