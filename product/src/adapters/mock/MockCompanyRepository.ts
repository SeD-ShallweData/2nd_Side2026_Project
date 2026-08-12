import type {
  Company,
  CompanyMatchType,
  CompanyRepository,
  CompanySearchResult,
} from "@/domain/company";
import { MOCK_COMPANIES } from "@/mocks/companies";
import { ServiceError } from "@/utils/errors";
import { normalizeSearchText } from "@/utils/text";

interface Match {
  matchedName: string;
  matchType: CompanyMatchType;
  rank: number;
}

function findMatch(company: Company, query: string): Match | null {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(company.company_name);
  const literalQuery = query.trim().toLocaleLowerCase("ko-KR");
  const literalName = company.company_name.trim().toLocaleLowerCase("ko-KR");

  if (literalName === literalQuery) {
    return { matchedName: company.company_name, matchType: "exact", rank: 0 };
  }
  if (normalizedName === normalizedQuery) {
    return { matchedName: company.company_name, matchType: "normalized", rank: 1 };
  }

  const alias = company.aliases.find((value) => normalizeSearchText(value) === normalizedQuery);
  if (alias) {
    return { matchedName: alias, matchType: "alias", rank: 2 };
  }

  if (normalizedName.includes(normalizedQuery)) {
    return { matchedName: company.company_name, matchType: "partial", rank: 3 };
  }

  const partialAlias = company.aliases.find((value) => normalizeSearchText(value).includes(normalizedQuery));
  if (partialAlias) {
    return { matchedName: partialAlias, matchType: "alias", rank: 4 };
  }
  return null;
}

export class MockCompanyRepository implements CompanyRepository {
  private matches(query: string) {
    if (normalizeSearchText(query) === "error") {
      throw new ServiceError(
        "COMPANY_SOURCE_UNAVAILABLE",
        "검색 서비스를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        503,
        true,
      );
    }

    return MOCK_COMPANIES.map((company) => ({ company, match: findMatch(company, query) }))
      .filter((entry): entry is { company: Company; match: Match } => entry.match !== null)
      .sort((a, b) => a.match.rank - b.match.rank || a.company.company_name.localeCompare(b.company.company_name, "ko"));
  }

  async search(query: string, limit = 10, offset = 0): Promise<CompanySearchResult[]> {
    return this.matches(query)
      .slice(offset, offset + limit)
      .map(({ company, match }) => ({
        company_id: company.company_id,
        company_name: company.company_name,
        address: company.address,
        region: company.region,
        industry: company.industry,
        size_label: company.size_label,
        matched_name: match.matchedName,
        match_type: match.matchType,
      }));
  }

  async count(query: string): Promise<number> {
    return this.matches(query).length;
  }

  async getById(companyId: string): Promise<Company | null> {
    return MOCK_COMPANIES.find((company) => company.company_id === companyId) ?? null;
  }
}
