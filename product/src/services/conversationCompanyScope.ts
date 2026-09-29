export interface RecallCompany {
  company_id: string;
  company_name: string;
  region?: string;
  address?: string;
}

function locationAliases(company: RecallCompany): string[] {
  const tokens = [company.region, ...(company.address?.split(/\s+/).slice(0, 2) ?? [])]
    .filter((value): value is string => Boolean(value));
  return [...new Set(tokens.flatMap((value) => [value, value.replace(/(?:특별자치도|특별자치시|광역시|특별시|도|시|군|구)$/, "")])
    .filter((value) => value.length >= 2))];
}

export function hasCompanyLocationQualifier(text: string, company: RecallCompany): boolean {
  return locationAliases(company).some((alias) => text.includes(alias));
}

export function mentionedCompanies(text: string, companies: RecallCompany[]): RecallCompany[] {
  const named = companies.filter((company, index) => company.company_name
    && text.includes(company.company_name)
    && companies.findIndex((candidate) => candidate.company_id === company.company_id) === index);
  const pool = named.length ? named : companies;
  const located = pool.filter((company) => hasCompanyLocationQualifier(text, company));
  if (located.length === 1) return located;
  return named;
}

/** Selected context is only a default; an explicit subject must not inherit it. */
export function statementCompany(
  text: string, selected: string | null, companies: RecallCompany[],
): { company_id: string | null; ambiguous: boolean } {
  const named = mentionedCompanies(text, companies);
  const ids = new Set(named.map((company) => company.company_id));
  if (ids.size > 1) return { company_id: null, ambiguous: true };
  // Unknown explicit subject, e.g. "새로운업체에서는 ...", is not selected-company evidence.
  // Do not resolve free text by searching public companies or create a new identity.
  const subject = text.trim().match(/^([^.!?。？\n]{1,60}?)(?:에서는|에서|은|는|의)\s/);
  if (subject) {
    const value = subject[1].trim();
    const contextual = /^(?:이\s*회사|그\s*회사|해당\s*회사|회사|여기|이곳|사장|사업주|대표|저|저희|우리|이번|이번에|이번\s*회사)$/.test(value)
      || /급여일|월급날|지급일|지급\s*약속|입금\s*약속|임금|월급/.test(value)
      || /^(?:제\s*)?(?:근로계약서|계약서|급여명세서|통장|출퇴근\s*기록)(?:\s*(?:원본|사본))?$/.test(value);
    const subjectMatches = companies.filter((company) => company.company_name === value);
    const locationMatchesNamed = named.length === 1 && hasCompanyLocationQualifier(value, named[0]);
    if (!contextual && subjectMatches.length !== 1 && !locationMatchesNamed) {
      // Guest-only history has no server company IDs. Its statements may be
      // repeated as unverified user claims, but must never inherit a selection.
      return { company_id: null, ambiguous: selected !== null || companies.length > 0 };
    }
    if (subjectMatches.length === 1) return { company_id: subjectMatches[0].company_id, ambiguous: false };
  }
  return { company_id: named[0]?.company_id ?? selected, ambiguous: false };
}
