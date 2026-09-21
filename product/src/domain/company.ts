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
  total_is_capped: boolean;
  has_more: boolean;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface CompanySearchFilters {
  region?: string;
  industry?: string;
}

export interface CompanyFilterOption {
  value: string;
  /** Lower bound used only for ordering/map shading; never an exact public count. */
  count: number;
  count_label: string;
}

export interface CompanyFilterOptions {
  regions: CompanyFilterOption[];
  industries: CompanyFilterOption[];
}

export interface CompanyRepository {
  search(
    query: string,
    limit?: number,
    offset?: number,
    filters?: CompanySearchFilters,
  ): Promise<CompanySearchResult[]>;
  count(query: string, filters?: CompanySearchFilters): Promise<number>;
  listFilterOptions(): Promise<CompanyFilterOptions>;
  getById(companyId: string): Promise<Company | null>;
}
