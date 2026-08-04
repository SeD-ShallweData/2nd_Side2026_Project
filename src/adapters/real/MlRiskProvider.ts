import type { CompanyRiskResult, RiskProvider } from "@/domain/risk";
import { ServiceError } from "@/utils/errors";

export class MlRiskProvider implements RiskProvider {
  async getCompanyRisk(): Promise<CompanyRiskResult | null> {
    throw new ServiceError(
      "RISK_SOURCE_UNAVAILABLE",
      "ML 운영 DB가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}
