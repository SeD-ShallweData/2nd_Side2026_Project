export interface RecallCompany {
  company_id: string;
  company_name: string;
}

export function mentionedCompanies(text: string, companies: RecallCompany[]): RecallCompany[] {
  return companies.filter((company, index) => company.company_name
    && text.includes(company.company_name)
    && companies.findIndex((candidate) => candidate.company_id === company.company_id) === index);
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
    const contextual = /^(?:이\s*회사|회사|사장|사업주|대표|저|저희|우리|이번\s*회사)$/.test(value)
      || /급여일|월급날|지급일|지급\s*약속|입금\s*약속|임금|월급/.test(value);
    const subjectMatches = companies.filter((company) => company.company_name === value);
    if (!contextual && subjectMatches.length !== 1) return { company_id: null, ambiguous: true };
    if (subjectMatches.length === 1) return { company_id: subjectMatches[0].company_id, ambiguous: false };
  }
  return { company_id: named[0]?.company_id ?? selected, ambiguous: false };
}
