import type { Metadata } from "next";
import { CompanySearch } from "@/components/company/CompanySearch";
import { DataModeNotice } from "@/components/company/DataModeNotice";
import { getCompanyDataMode } from "@/config/dataMode";

export const metadata: Metadata = {
  title: "사업장 확인",
};

export default function CompaniesPage() {
  const dataMode = getCompanyDataMode();
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">AI 분석 기반 사업장 신뢰 정보</span>
          <h1>궁금한 업장을 검색해주세요!</h1>
          <p>회사명을 검색한 뒤 지역과 업종을 비교해 정확한 사업장을 직접 선택하세요.</p>
        </div>
        <DataModeNotice
          dataMode={dataMode}
          realMessage="PostgreSQL의 사업장 명부를 읽기 전용으로 조회합니다. 검색 결과는 10개씩 나누어 보여드립니다."
          mockMessage="현재 화면의 사업장과 분석 결과는 시연을 위한 명시된 데모 데이터입니다."
        />
        <CompanySearch />
      </div>
    </div>
  );
}
