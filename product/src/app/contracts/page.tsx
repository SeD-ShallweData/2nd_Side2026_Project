import type { Metadata } from "next";
import { ContractReviewPanel } from "@/components/contract/ContractReviewPanel";
import { getContractDataMode } from "@/config/dataMode";

export const metadata: Metadata = { title: "근로계약서 확인" };

export default function ContractsPage() {
  const dataMode = getContractDataMode();
  return (
    <div className="page-section contract-page refresh-contract-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">근로계약서 확인</span>
          <h1>계약서에서 놓친 항목이 있나요?</h1>
          <p>파일을 올리면 확인된 항목, 누락 가능 항목과 회사에 다시 물어볼 질문을 구분합니다.</p>
        </div>
        <div className={`mode-banner mode-banner-${dataMode}`} role="status">
          <span>{dataMode === "real" ? "DOCUMENT ANALYSIS" : "DEMO"}</span>
          {dataMode === "real"
            ? "파일은 내부 계약서 분석 서비스로 전달되며 원문을 제품 서버나 Git에 저장하지 않습니다."
            : "데모 모드에서는 파일 내용을 분석하지 않고 명시된 시나리오 결과만 제공합니다."}
        </div>
        <ContractReviewPanel dataMode={dataMode} />
      </div>
    </div>
  );
}
