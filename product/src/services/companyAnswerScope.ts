import { hasCompanyLocationQualifier, type RecallCompany } from "@/services/conversationCompanyScope";

/** Resolve only companies supplied by the owner-checked conversation, never free-text search. */
export function referencedCompanyIds(message: string, companies: RecallCompany[], selectedId?: string): string[] {
  const unique = [...new Map(companies.map((company) => [company.company_id, company])).values()];
  const named = unique.filter((company) => message.includes(company.company_name));
  const located = unique.filter((company) => hasCompanyLocationQualifier(message, company));
  if (located.length) {
    const uniqueNamed = named.filter((company) =>
      unique.filter((other) => other.company_name === company.company_name).length === 1);
    return [...new Set([...located, ...uniqueNamed].map((company) => company.company_id))];
  }
  if (named.length === 1) return [named[0].company_id];
  if (named.length > 1 && new Set(named.map((company) => company.company_name)).size === named.length) {
    return named.map((company) => company.company_id);
  }
  if (named.length > 1) return selectedId && named.some((company) => company.company_id === selectedId)
    ? [selectedId] : [];
  return selectedId ? [selectedId] : [];
}

export function asksPublicCompanyComparison(message: string, companyIds: string[]): boolean {
  return companyIds.length > 1
    && /공개\s*(?:자료|카드|지표|신호)|(?:임금|안전|산재)\s*(?:카드|지표|신호)/.test(message)
    && !/(?:못\s*받|미지급|체불\s*진정|신고\s*방법)/.test(message);
}
