import { getCompanyDataMode, getMockDelayMs } from "@/config/dataMode";
import type {
  Company,
  CompanyFilterOptions,
  CompanySearchFilters,
  CompanySearchResponse,
} from "@/domain/company";
import { delay } from "@/utils/delay";
import { ServiceError } from "@/utils/errors";
import { getCompanyRepository } from "@/services/providers";

function normalizeFilters(filters: CompanySearchFilters): CompanySearchFilters {
  const normalized = {
    region: filters.region?.trim() || undefined,
    industry: filters.industry?.trim() || undefined,
  };
  if ((normalized.region?.length ?? 0) > 100 || (normalized.industry?.length ?? 0) > 200) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검색 필터를 확인해 주세요.",
      400,
      false,
      [{ field: "filters", reason: "지역은 100자, 업종은 200자 이하여야 합니다." }],
    );
  }
  return normalized;
}

export async function searchCompanies(
  query: string,
  limit = 10,
  page = 1,
  filters: CompanySearchFilters = {},
): Promise<CompanySearchResponse> {
  const normalizedQuery = query.trim();
  const normalizedFilters = normalizeFilters(filters);
  /*
   * 검색어 없이 지역·업종만으로도 찾을 수 있다. 지도에서 지역을 고르는 길이
   * 생기면서 필요해졌다. 다만 아무 조건 없이 전체를 훑는 것은 계속 막는다 —
   * 그것은 검색이 아니라 명부 전체 내려받기다.
   */
  const hasFilter = Boolean(normalizedFilters.region || normalizedFilters.industry);
  if (normalizedQuery.length > 100 || (normalizedQuery.length < 1 && !hasFilter)) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검색어를 확인해 주세요.",
      400,
      false,
      [{ field: "q", reason: "검색어는 100자 이하여야 하고, 비우려면 지역이나 업종을 골라야 합니다." }],
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
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "검색 페이지를 확인해 주세요.",
      400,
      false,
      [{ field: "page", reason: "page는 1 이상의 정수여야 합니다." }],
    );
  }

  if (getCompanyDataMode() === "mock") await delay(getMockDelayMs());
  const repository = getCompanyRepository();
  const [items, total] = await Promise.all([
    repository.search(normalizedQuery, limit, (page - 1) * limit, normalizedFilters),
    repository.count(normalizedQuery, normalizedFilters),
  ]);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    query: normalizedQuery,
    items,
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export async function getCompanyFilterOptions(): Promise<CompanyFilterOptions> {
  if (getCompanyDataMode() === "mock") await delay(getMockDelayMs());
  return getCompanyRepository().listFilterOptions();
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
