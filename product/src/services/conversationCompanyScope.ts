export interface RecallCompany {
  company_id: string;
  company_name: string;
  region?: string | null;
  address?: string | null;
}

export function locationAliases(company: RecallCompany): string[] {
  const tokens = [company.region, ...(company.address?.split(/\s+/).slice(0, 2) ?? [])]
    .filter((value): value is string => Boolean(value));
  return [...new Set(tokens.flatMap((value) => [value, value.replace(/(?:특별자치도|특별자치시|광역시|특별시|도|시|군|구)$/, "")])
    .filter((value) => value.length >= 2))];
}

export function hasCompanyLocationQualifier(text: string, company: RecallCompany): boolean {
  return locationAliases(company).some((alias) => text.includes(alias));
}

export function recallCompanyLabel(company: RecallCompany, companies: RecallCompany[]): string {
  if (!companies.some(other => other.company_id !== company.company_id && other.company_name === company.company_name)) return company.company_name;
  return `${company.address?.split(/\s+/).slice(0, 2).join(" ") || company.region || "지역 미확인"} ${company.company_name}`;
}

export function mentionedCompanies(text: string, companies: RecallCompany[]): RecallCompany[] {
  const named = companies.filter((company, index) => company.company_name
    && text.includes(company.company_name)
    && companies.findIndex((candidate) => candidate.company_id === company.company_id) === index);
  const pool = named.length ? named : companies;
  const located = pool.filter((company) => hasCompanyLocationQualifier(text, company));
  if (located.length === 1) return located;
  // Multiple locations are usable only when each distinguishes one known firm.
  const uniqueLocations = located.map(company => ({ company, positions: locationAliases(company)
    .filter(alias => text.includes(alias) && !pool.some(other => other.company_id !== company.company_id && locationAliases(other).includes(alias)))
    .map(alias => text.indexOf(alias)) }));
  if (located.length > 1 && uniqueLocations.every(item => item.positions.length)) {
    return uniqueLocations.sort((a,b) => Math.min(...a.positions) - Math.min(...b.positions)).map(item => item.company);
  }
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
    const joinedDocumentSubject = /^하루\s*\d{1,2}\s*시간\s*(?:일하며|일하고|근무하며|근무하고)\s*(?:급여명세서|임금명세서|(?:근로)?계약서|통장\s*사본)$/.test(value);
    const subjectMatches = companies.filter((company) => company.company_name === value);
    const locationMatchesNamed = named.length === 1 && hasCompanyLocationQualifier(value, named[0]);
    const namedSubjectPrefix = named.length === 1 && value.startsWith(named[0].company_name)
      && /^(?:$|[\s은는의을를에서])/.test(value.slice(named[0].company_name.length));
    if (!contextual && !joinedDocumentSubject && subjectMatches.length !== 1 && !locationMatchesNamed && !namedSubjectPrefix) {
      // Guest-only history has no server company IDs. Its statements may be
      // repeated as unverified user claims, but must never inherit a selection.
      return { company_id: null, ambiguous: selected !== null || companies.length > 0 };
    }
    if (subjectMatches.length === 1) return { company_id: subjectMatches[0].company_id, ambiguous: false };
  }
  return { company_id: named[0]?.company_id ?? selected, ambiguous: false };
}
