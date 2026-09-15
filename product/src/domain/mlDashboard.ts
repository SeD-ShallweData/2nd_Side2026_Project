export type MlDashboardTab = "wage" | "safety";

export interface MlDashboardDistributionRow {
  region: string;
  industry: string;
  firm_count: number;
  categories: Array<{
    key: string;
    label: string;
    count: number;
    ratio: number | null;
  }>;
}

export interface MlDashboardResponse {
  tab: MlDashboardTab;
  denominator: number;
  data_as_of: string | null;
  target_label: string | null;
  stale_notice: string | null;
  basis_notice: string;
  filters: { region: string | null; industry: string | null };
  options: { regions: string[]; industries: string[] };
  rows: MlDashboardDistributionRow[];
}
