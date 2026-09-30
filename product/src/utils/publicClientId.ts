const STORAGE_KEY = "moneyworry.public_client_id.v1";

export function publicClientHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    let value = window.sessionStorage.getItem(STORAGE_KEY);
    if (!value) {
      value = crypto.randomUUID();
      window.sessionStorage.setItem(STORAGE_KEY, value);
    }
    return { "X-MoneyWorry-Client-Id": value };
  } catch {
    // 저장소를 막은 브라우저에서도 요청은 그대로 보낸다. 서버는 표시값 없는 요청을 한 묶음으로 센다.
    return {};
  }
}
