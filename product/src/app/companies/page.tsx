import type { Metadata } from "next";
import { CompanySearch } from "@/components/company/CompanySearch";

export const metadata: Metadata = {
  title: "사업장 확인",
};

export default function CompaniesPage() {
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">사업장 신뢰 정보</span>
          <h1>어느 사업장을 확인할까요?</h1>
          <p>회사명을 검색한 뒤 주소와 업종을 비교해 정확한 사업장을 직접 선택하세요.</p>
        </div>
        <div className="mock-banner" role="status">
          <span>MOCK</span>
          현재 화면의 사업장과 분석 결과는 시연을 위한 가상 데이터입니다.
        </div>
        <CompanySearch />
      </div>
    </div>
  );
}
