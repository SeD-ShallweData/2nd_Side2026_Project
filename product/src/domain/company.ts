export type CompanyMatchType = "exact" | "normalized" | "partial" | "alias";

export interface Company {
  company_id: string;
  company_name: string;
  address: string | null;
  region: string | null;
  industry: string | null;
  size_label: string | null;
  aliases: string[];
  data_as_of: string | null;
}

export interface CompanySearchResult {
  company_id: string;
  company_name: string;
  address: string | null;
  region: string | null;
  industry: string | null;
  size_label: string | null;
  matched_name: string;
  match_type: CompanyMatchType;
}

export interface CompanySearchResponse {
  query: string;
  items: CompanySearchResult[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface CompanyRepository {
  search(query: string, limit?: number, offset?: number): Promise<CompanySearchResult[]>;
  count(query: string): Promise<number>;
  getById(companyId: string): Promise<Company | null>;
}
