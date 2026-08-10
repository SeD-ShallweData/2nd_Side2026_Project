export type CompanyMatchType = "exact" | "normalized" | "partial" | "alias";

export interface Company {
  company_id: string;
  company_name: string;
  address: string;
  region: string;
  industry: string;
  size_label: string;
  aliases: string[];
  data_as_of: string;
}

export interface CompanySearchResult {
  company_id: string;
  company_name: string;
  address: string;
  region: string;
  industry: string;
  size_label: string;
  matched_name: string;
  match_type: CompanyMatchType;
}

export interface CompanySearchResponse {
  query: string;
  items: CompanySearchResult[];
  total: number;
  has_more: boolean;
}

export interface CompanyRepository {
  search(query: string, limit?: number): Promise<CompanySearchResult[]>;
  getById(companyId: string): Promise<Company | null>;
}
