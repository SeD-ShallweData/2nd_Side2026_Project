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
  /** 소규모 셀을 차감해 유추할 수 있으면 공개하지 않는다. */
  denominator: number | null;
  data_as_of: string | null;
  target_label: string | null;
  stale_notice: string | null;
  basis_notice: string;
  filters: { region: string | null; industry: string | null };
  options: {
    regions: Array<{ value: string; count: number | null }>;
    industries: Array<{ value: string; count: number | null }>;
  };
  rows: MlDashboardDistributionRow[];
}
