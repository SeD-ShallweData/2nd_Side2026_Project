const NON_PUBLIC_INDUSTRY_LABELS = new Set([
  "BIZ_NO미존재사업장",
  "해당없음",
]);

/** Convert DB-only missing-value labels to an absent public field. */
export function toPublicIndustry(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || NON_PUBLIC_INDUSTRY_LABELS.has(normalized)) return null;
  return normalized;
}
