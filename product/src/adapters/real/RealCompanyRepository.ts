import type { Company, CompanyRepository, CompanySearchResult } from "@/domain/company";
import { ServiceError } from "@/utils/errors";

export class RealCompanyRepository implements CompanyRepository {
  async search(): Promise<CompanySearchResult[]> {
    throw this.unavailable();
  }

  async getById(): Promise<Company | null> {
    throw this.unavailable();
  }

  private unavailable(): ServiceError {
    return new ServiceError(
      "COMPANY_SOURCE_UNAVAILABLE",
      "실제 사업장 저장소가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}
