import { getMockDelayMs } from "@/config/dataMode";
import type { Company } from "@/domain/company";
import type { CompanyRiskResult } from "@/domain/risk";
import { getCompanyById } from "@/services/companyService";
import { getRiskProvider } from "@/services/providers";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getFreshnessFromValidUntil(validUntil: string | null, now = new Date()): CompanyRiskResult["freshness"] {
  if (validUntil === null) return "unknown";
  if (!DATE_ONLY_PATTERN.test(validUntil)) {
    throw new ServiceError("INVALID_RISK_RESULT", "분석 결과의 유효기간 형식이 올바르지 않습니다.", 502, true);
  }
  const expiresAt = new Date(`${validUntil}T23:59:59.999+09:00`);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ServiceError("INVALID_RISK_RESULT", "분석 결과의 유효기간을 확인할 수 없습니다.", 502, true);
  }
  return expiresAt.getTime() < now.getTime() ? "expired" : "current";
}

export function assertRiskIdentity(company: Company, result: CompanyRiskResult): void {
  if (result.company_id !== company.company_id || result.company_name !== company.company_name) {
    throw new ServiceError(
      "RISK_RESULT_MISMATCH",
      "선택한 사업장과 분석 결과가 일치하지 않습니다.",
      502,
      false,
    );
  }
}

export async function getCompanyRisk(companyId: string): Promise<CompanyRiskResult> {
  const company = await getCompanyById(companyId);
  await delay(getMockDelayMs());
  const result = await getRiskProvider().getCompanyRisk(company.company_id);
  if (!result) {
    throw new ServiceError("RISK_RESULT_NOT_FOUND", "사업장 분석 결과를 찾을 수 없습니다.", 404, false);
  }
  assertRiskIdentity(company, result);
  return {
    ...result,
    freshness: getFreshnessFromValidUntil(result.valid_until),
  };
}
