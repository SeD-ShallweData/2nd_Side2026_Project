import type { Metadata } from "next";
import { CompanySearch } from "@/components/company/CompanySearch";
import { getDataMode } from "@/config/dataMode";

export const metadata: Metadata = {
  title: "사업장 확인",
};

export default function CompaniesPage() {
  const dataMode = getDataMode();
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">사업장 신뢰 정보</span>
          <h1>어느 사업장을 확인할까요?</h1>
          <p>회사명을 검색한 뒤 주소와 업종을 비교해 정확한 사업장을 직접 선택하세요.</p>
        </div>
        <div className={`mode-banner mode-banner-${dataMode}`} role="status">
          <span>{dataMode === "real" ? "READ ONLY DB" : "DEMO"}</span>
          {dataMode === "real"
            ? "PostgreSQL의 사업장 명부를 읽기 전용으로 조회합니다. DB에 없는 주소·규모는 정보 없음으로 표시합니다."
            : "현재 화면의 사업장과 분석 결과는 시연을 위한 명시된 데모 데이터입니다."}
        </div>
        <CompanySearch />
      </div>
    </div>
  );
}
