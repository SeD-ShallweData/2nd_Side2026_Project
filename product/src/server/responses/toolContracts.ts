import type { CompanySearchResponse } from "@/domain/company";
import type { ContractReviewRequest, ContractReviewResult } from "@/domain/contract";
import type { RagRetrievalResult } from "@/domain/rag";
import type { CompanyRiskResult } from "@/domain/risk";
import type { ErrorDetail } from "@/utils/errors";

export const TOOL_NAMES = [
  "search_company",
  "get_company_risk",
  "retrieve_labor_law",
  "review_contract",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolInputMap {
  search_company: {
    query: string;
    limit: number | null;
  };
  get_company_risk: {
    company_id: string;
  };
  retrieve_labor_law: {
    query: string;
  };
  review_contract: {
    document_ref: "current_upload";
  };
}

export interface ToolOutputMap {
  search_company: CompanySearchResponse;
  get_company_risk: CompanyRiskResult;
  retrieve_labor_law: RagRetrievalResult;
  review_contract: ContractReviewResult;
}

/** 모델 인자가 아니라 현재 HTTP 요청이 소유하는 서버 측 실행 문맥이다. */
export interface ToolExecutionContext {
  contractRequest?: ContractReviewRequest;
  /** 사용자가 UI/API에서 명시적으로 선택한 사업장만 위험 조회에 사용할 수 있다. */
  selectedCompanyId?: string;
  signal?: AbortSignal;
}

export type ToolExecutionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: ErrorDetail[];
      };
    };

export type AnyToolExecutionResult = ToolExecutionResult<ToolOutputMap[ToolName]>;

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

export function hasCurrentContractUpload(context: ToolExecutionContext): boolean {
  return Boolean(context.contractRequest?.file && context.contractRequest.file_metadata);
}
