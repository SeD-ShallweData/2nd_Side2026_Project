import type { Metadata } from "next";
import { ContractReviewPanel } from "@/components/contract/ContractReviewPanel";

export const metadata: Metadata = { title: "근로계약서 확인" };

export default function ContractsPage() {
  return (
    <div className="page-section contract-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">근로계약 기본 항목</span>
          <h1>계약서에서 무엇을 확인해야 할까요?</h1>
          <p>Mock 결과로 누락 가능 항목과 회사에 추가로 물어볼 질문을 확인합니다.</p>
        </div>
        <div className="mock-banner" role="status">
          <span>MOCK</span>
          파일은 영구 저장되지 않으며 현재 단계에서는 실제 내용도 분석하지 않습니다.
        </div>
        <ContractReviewPanel />
      </div>
    </div>
  );
}
