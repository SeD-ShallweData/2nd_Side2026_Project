const STORAGE_KEY = "moneyworry.public_client_id.v1";

export function publicClientHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  let value = window.sessionStorage.getItem(STORAGE_KEY);
  if (!value) {
    value = crypto.randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, value);
  }
  return { "X-MoneyWorry-Client-Id": value };
}
