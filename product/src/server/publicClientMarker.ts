import "server-only";

/** 탭 표시값이 없거나 형식이 틀린 요청을 한데 묶는 이름. 올바른 표시값은 16자 이상이라 겹치지 않는다. */
export const UNMARKED_CLIENT = "unmarked";

/**
 * 브라우저 탭 표시값(X-MoneyWorry-Client-Id, utils/publicClientId.ts 가 붙인다).
 * 사용자가 바꿀 수 있는 값이므로 한도를 나누는 데만 쓰고 신원 확인에는 쓰지 않는다.
 */
export function publicClientMarker(request: Request): string {
  const value = request.headers.get("x-moneyworry-client-id")?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,100}$/.test(value) ? value : UNMARKED_CLIENT;
}
