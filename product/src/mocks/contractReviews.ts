import type { ContractReviewResult } from "@/domain/contract";

export const MOCK_CONTRACT_REVIEW: ContractReviewResult = {
  analysis_status: "mocked",
  detected_items: [
    {
      code: "CONTRACT_PERIOD",
      label: "계약기간",
      status: "detected",
      description: "계약 시작일과 종료일 항목이 확인됐습니다.",
    },
    {
      code: "WORK_LOCATION",
      label: "근무 장소",
      status: "detected",
      description: "근무 장소 항목이 확인됐습니다.",
      legal_basis: "근로기준법 시행령 제8조",
    },
    {
      code: "BASE_WAGE",
      label: "기본급",
      status: "detected",
      description: "기본급 금액 항목이 확인됐습니다.",
      legal_basis: "근로기준법 제17조",
    },
  ],
  missing_items: [
    {
      code: "PAYDAY",
      label: "임금 지급일",
      status: "missing",
      description: "임금을 지급하는 날짜가 명확히 확인되지 않습니다.",
      legal_basis: "근로기준법 제17조",
    },
    {
      code: "WORKING_HOURS",
      label: "소정근로시간",
      status: "missing",
      description: "시업·종업 시각과 휴게시간을 확인하기 어렵습니다.",
      legal_basis: "근로기준법 제17조",
    },
    {
      code: "ANNUAL_LEAVE",
      label: "연차 유급휴가",
      status: "missing",
      description: "연차 유급휴가 관련 항목이 확인되지 않습니다.",
      legal_basis: "근로기준법 제17조",
    },
  ],
  review_items: [
    {
      code: "INCLUSIVE_WAGE",
      label: "포괄임금제 적용 여부",
      status: "review",
      description: "수당이 기본급에 포함되는지와 계산 기준을 회사에 확인해 보세요.",
    },
    {
      code: "PROBATION_WAGE",
      label: "수습기간 중 임금 조건",
      status: "review",
      description: "수습기간과 그 기간의 임금 조건을 구체적으로 확인해 보세요.",
    },
    {
      code: "OVERTIME_PAY",
      label: "연장근로 수당 계산 기준",
      status: "review",
      description: "연장·야간·휴일근로 수당의 계산과 지급 방식을 확인해 보세요.",
    },
  ],
  warnings: [
    "Mock 검토 결과이며 실제 파일 내용 분석 결과가 아닙니다.",
    "문서 인식 결과에서 보이지 않는 항목이 실제 계약서에는 존재할 수 있으므로 원문을 직접 확인하세요.",
  ],
  suggested_questions: [
    "임금 지급일은 매월 며칠인가요?",
    "출퇴근 시각과 휴게시간은 계약서 어디에 적히나요?",
    "연장·야간·휴일근로 수당은 어떻게 계산되나요?",
  ],
  limitations: [
    "이 결과는 계약서의 법적 효력을 확정하거나 전문 법률 검토를 대체하지 않습니다.",
    "정확한 기준은 고용노동부 1350 또는 전문가에게 확인하세요.",
  ],
};
