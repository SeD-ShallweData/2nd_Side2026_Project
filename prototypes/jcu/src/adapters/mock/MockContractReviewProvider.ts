import type {
  ContractItem,
  ContractReviewProvider,
  ContractReviewRequest,
  ContractReviewResult,
} from "@/domain/contract";
import { MOCK_CONTRACT_REVIEW } from "@/mocks/contractReviews";

const COMPLETE_ITEMS: ContractItem[] = [
  ["WAGE", "임금", "근로기준법 제17조"],
  ["WORKING_HOURS", "소정근로시간", "근로기준법 제17조"],
  ["HOLIDAYS", "휴일", "근로기준법 제17조"],
  ["ANNUAL_LEAVE", "연차 유급휴가", "근로기준법 제17조"],
  ["WORK_LOCATION", "근무 장소", "근로기준법 시행령 제8조"],
  ["JOB_DESCRIPTION", "업무 내용", "근로기준법 시행령 제8조"],
].map(([code, label, legalBasis]) => ({
  code,
  label,
  status: "detected" as const,
  description: `${label} 항목이 확인됐습니다.`,
  legal_basis: legalBasis,
}));

export class MockContractReviewProvider implements ContractReviewProvider {
  async review(request: ContractReviewRequest): Promise<ContractReviewResult> {
    const complete =
      request.scenario_id === "complete" ||
      request.file_metadata?.file_name.toLocaleLowerCase("ko-KR").includes("complete") ||
      request.text?.includes("모든 필수 항목 포함");

    if (complete) {
      return {
        analysis_status: "mocked",
        detected_items: COMPLETE_ITEMS,
        missing_items: [],
        review_items: [],
        warnings: ["Mock 검토 결과이며 실제 파일 내용 분석 결과가 아닙니다."],
        suggested_questions: ["계약서 사본은 언제 받을 수 있나요?"],
        limitations: [
          "기본 항목이 표시됐다는 사실만 확인하며 계약 내용의 적법성이나 유효성을 확정하지 않습니다.",
          "정확한 기준은 고용노동부 1350 또는 전문가에게 확인하세요.",
        ],
      };
    }

    return structuredClone(MOCK_CONTRACT_REVIEW);
  }
}
