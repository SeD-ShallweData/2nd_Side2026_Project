export type FavoriteApiSource = "mock_memory" | "database";

export interface FavoriteCompanyDto {
  company_id: string;
  company_name: string;
  region: string | null;
  industry: string | null;
  created_at: string;
}

export interface FavoriteListResponse {
  source: FavoriteApiSource;
  items: FavoriteCompanyDto[];
  total: number;
}

export interface FavoriteUpsertResponse {
  source: FavoriteApiSource;
  favorite: FavoriteCompanyDto;
  created: boolean;
}

export interface FavoriteDeleteResponse {
  deleted: true;
  company_id: string;
}
