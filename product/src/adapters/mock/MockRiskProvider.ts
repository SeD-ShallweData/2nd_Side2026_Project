import type { CompanyRiskResult, RiskProvider } from "@/domain/risk";
import { MOCK_RISKS } from "@/mocks/risks";
import { ServiceError } from "@/utils/errors";

export class MockRiskProvider implements RiskProvider {
  async getCompanyRisk(companyId: string): Promise<CompanyRiskResult | null> {
    if (companyId === "ERROR_001") {
      throw new ServiceError(
        "RISK_SOURCE_UNAVAILABLE",
        "사업장 신호 데이터를 불러오지 못했습니다.",
        503,
        true,
      );
    }
    return MOCK_RISKS[companyId] ?? null;
  }
}
