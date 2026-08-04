export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLocaleLowerCase("ko-KR");
}

export function containsAny(value: string, keywords: string[]): boolean {
  const normalized = value.toLocaleLowerCase("ko-KR");
  return keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase("ko-KR")));
}
