import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompanyDetail } from "@/components/company/CompanyDetail";
import { getCompanyById } from "@/services/companyService";
import { getCompanyRisk } from "@/services/riskService";
import { getCompanyDataMode } from "@/config/dataMode";
import type { CompanyRiskResult } from "@/domain/risk";

interface PageProps {
  params: Promise<{ companyId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const { companyId } = await params;
    const company = await getCompanyById(decodeURIComponent(companyId));
    return { title: `${company.company_name} 확인` };
  } catch {
    return { title: "사업장 정보" };
  }
}

export default async function CompanyDetailPage({ params }: PageProps) {
  const { companyId } = await params;
  const decodedId = decodeURIComponent(companyId);

  /*
   * 두 조회를 따로 감싼다. 합치면 안 된다.
   *
   * getCompanyRisk 는 분석 결과가 없을 때 RISK_RESULT_NOT_FOUND(404) 를 던진다
   * (riskService.ts:38-40). 같은 try 에 넣으면 그 404 가 notFound() 로 이어져
   * **사업장 페이지 전체가 사라진다** — 전에는 사업장 정보는 뜨고 카드 자리에만
   * EmptyState 가 보였다. 그 동작을 그대로 유지한다.
   */
  let company;
  try {
    company = await getCompanyById(decodedId);
  } catch {
    notFound();
  }

  let risk: CompanyRiskResult | null = null;
  try {
    risk = await getCompanyRisk(decodedId);
  } catch {
    // 분석 결과가 없거나 조회가 실패하면 null 로 둔다.
    // CompanyDetail 이 EmptyState 를 그린다.
  }

  return <CompanyDetail company={company} risk={risk} dataMode={getCompanyDataMode()} />;
}
