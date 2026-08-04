import { getMockDelayMs } from "@/config/dataMode";
import type { CompanyRiskResult } from "@/domain/risk";
import { getCompanyById } from "@/services/companyService";
import { getRiskProvider } from "@/services/providers";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";

export async function getCompanyRisk(companyId: string): Promise<CompanyRiskResult> {
  const company = await getCompanyById(companyId);
  await delay(getMockDelayMs());
  const result = await getRiskProvider().getCompanyRisk(company.company_id);
  if (!result) {
    throw new ServiceError("RISK_RESULT_NOT_FOUND", "사업장 분석 결과를 찾을 수 없습니다.", 404, false);
  }
  return result;
}
