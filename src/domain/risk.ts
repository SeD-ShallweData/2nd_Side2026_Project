export type SignalLevel = "normal" | "watch" | "review" | "unknown";
export type Confidence = "sufficient" | "limited" | "unavailable";
export type Freshness = "current" | "expired";

export interface SourceReference {
  name: string;
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
  as_of: string | null;
  source_name?: string;
}

export interface WageRiskPublic {
  level: SignalLevel;
  summary: string;
  evidence_codes: string[];
  evidence_items: EvidenceItem[];
  confidence: Confidence;
  official_listing: OfficialListingStatus;
}

export interface SafetyContextPublic {
  scope: "region_industry";
  level: SignalLevel;
  summary: string;
  region: string;
  industry: string;
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
  data_as_of: string;
  generated_at: string;
  valid_until: string;
  freshness: Freshness;
  wage_risk: WageRiskPublic;
  safety_context: SafetyContextPublic;
  sources: SourceReference[];
}

export interface RiskProvider {
  getCompanyRisk(companyId: string): Promise<CompanyRiskResult | null>;
}
