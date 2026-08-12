import type { ContractReviewRequest } from "@/domain/contract";
import { getCompanyRisk } from "@/services/riskService";
import { searchCompanies } from "@/services/companyService";
import { reviewContract } from "@/services/contractService";
import { retrieveLaborLawContext } from "@/services/ragService";
import type {
  ToolExecutionContext,
  ToolInputMap,
  ToolName,
  ToolOutputMap,
} from "@/server/responses/toolContracts";
import { ServiceError } from "@/utils/errors";

export interface ToolServiceDependencies {
  searchCompanies: typeof searchCompanies;
  getCompanyRisk: typeof getCompanyRisk;
  retrieveLaborLawContext: typeof retrieveLaborLawContext;
  reviewContract: typeof reviewContract;
}

export type ToolHandler<K extends ToolName> = (
  input: ToolInputMap[K],
  context: ToolExecutionContext,
) => Promise<ToolOutputMap[K]>;

export type ToolHandlerMap = {
  [K in ToolName]: ToolHandler<K>;
};

const DEFAULT_DEPENDENCIES: ToolServiceDependencies = {
  searchCompanies,
  getCompanyRisk,
  retrieveLaborLawContext,
  reviewContract,
};

function currentContractRequest(context: ToolExecutionContext): ContractReviewRequest {
  const request = context.contractRequest;
  if (!request?.file || !request.file_metadata) {
    throw new ServiceError(
      "CONTRACT_FILE_REQUIRED",
      "현재 요청에 검토할 계약서 업로드가 없습니다.",
      400,
      false,
    );
  }
  return context.signal ? { ...request, signal: context.signal } : request;
}

function selectedCompanyId(
  requestedCompanyId: string,
  context: ToolExecutionContext,
): string {
  if (!context.selectedCompanyId) {
    throw new ServiceError(
      "COMPANY_SELECTION_REQUIRED",
      "위험 정보를 조회하려면 검색 후보에서 사업장을 먼저 선택해야 합니다.",
      400,
      false,
    );
  }
  if (requestedCompanyId !== context.selectedCompanyId) {
    throw new ServiceError(
      "COMPANY_CONTEXT_MISMATCH",
      "선택한 사업장과 도구가 요청한 사업장이 일치하지 않습니다.",
      400,
      false,
    );
  }
  return context.selectedCompanyId;
}

export function createToolHandlers(
  dependencies: ToolServiceDependencies = DEFAULT_DEPENDENCIES,
): ToolHandlerMap {
  return {
    search_company: async (input) =>
      dependencies.searchCompanies(input.query, input.limit ?? 10),
    get_company_risk: async (input, context) =>
      dependencies.getCompanyRisk(selectedCompanyId(input.company_id, context)),
    retrieve_labor_law: async (input, context) =>
      context.signal
        ? dependencies.retrieveLaborLawContext(input.query, context.signal)
        : dependencies.retrieveLaborLawContext(input.query),
    review_contract: async (_input, context) =>
      dependencies.reviewContract(currentContractRequest(context)),
  };
}
