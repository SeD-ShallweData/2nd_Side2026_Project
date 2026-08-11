import { getCompanyDataMode, getMockDelayMs } from "@/config/dataMode";
import type { Company, CompanySearchResponse } from "@/domain/company";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";
import { getCompanyRepository } from "@/services/providers";

export async function searchCompanies(query: string, limit = 10): Promise<CompanySearchResponse> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 1 || normalizedQuery.length > 100) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검색어를 확인해 주세요.",
      400,
      false,
      [{ field: "q", reason: "검색어는 한 글자 이상 100자 이하여야 합니다." }],
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검색 개수를 확인해 주세요.",
      400,
      false,
      [{ field: "limit", reason: "limit은 1 이상 20 이하의 정수여야 합니다." }],
    );
  }

  if (getCompanyDataMode() === "mock") await delay(getMockDelayMs());
  const items = await getCompanyRepository().search(normalizedQuery, limit);
  return {
    query: normalizedQuery,
    items,
    total: items.length,
    has_more: false,
  };
}

export async function getCompanyById(companyId: string): Promise<Company> {
  const normalized = companyId.trim();
  if (!normalized || normalized.length > 64) {
    throw new ServiceError("INVALID_COMPANY_ID", "사업장 식별값을 확인해 주세요.", 400, false);
  }

  const company = await getCompanyRepository().getById(normalized);
  if (!company) {
    throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
  }
  return company;
}
