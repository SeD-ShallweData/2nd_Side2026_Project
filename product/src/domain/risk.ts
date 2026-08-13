export type SignalLevel = "normal" | "watch" | "review" | "unknown";
export type Confidence = "sufficient" | "limited" | "unavailable";
export type Freshness = "current" | "expired" | "unknown";
export type SignalAvailability = "ready" | "no_data" | "unavailable";
export type SourceCategory = "wage" | "safety" | "labor_law";

export interface SourceReference {
  name: string;
  category?: SourceCategory;
  citation?: string;
  organization?: string;
  as_of?: string;
  url?: string;
  document_id?: string;
}

export interface EvidenceItem {
  code: string;
  label: string;
  description: string;
}

export interface OfficialListingStatus {
  status: "listed" | "not_listed" | "unavailable";
  /** 명단 자체의 공표일 또는 검증된 스냅샷 기준일. 모델 배치일로 대신하지 않는다. */
  as_of: string | null;
  source_name?: string;
}

export interface WageRiskPublic {
  availability?: SignalAvailability;
  level: SignalLevel;
  summary: string;
  evidence_codes: string[];
  evidence_items: EvidenceItem[];
  confidence: Confidence;
  official_listing: OfficialListingStatus;
}

export interface SafetyContextPublic {
  availability?: SignalAvailability;
  scope: "region_industry" | "validated_firm_context";
  level: SignalLevel;
  summary: string;
  region: string | null;
  industry: string | null;
  target_start?: string;
  target_end?: string;
  evidence_codes: string[];
  evidence_items: EvidenceItem[];
  confidence: Confidence;
  disclaimer: string;
}

export interface CompanyRiskResult {
  company_id: string;
  company_name: string;
  data_as_of: string | null;
  target_month?: string | null;
  generated_at: string | null;
  valid_until: string | null;
  freshness: Freshness;
  wage_risk: WageRiskPublic;
  safety_context: SafetyContextPublic;
  sources: SourceReference[];
}

export interface RiskProvider {
  getCompanyRisk(companyId: string): Promise<CompanyRiskResult | null>;
}
