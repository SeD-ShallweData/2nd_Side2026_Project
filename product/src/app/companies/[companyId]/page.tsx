import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompanyDetail } from "@/components/company/CompanyDetail";
import { getCompanyById } from "@/services/companyService";
import { getDataMode } from "@/config/dataMode";

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
  let company;
  try {
    const { companyId } = await params;
    company = await getCompanyById(decodeURIComponent(companyId));
  } catch {
    notFound();
  }
  return <CompanyDetail company={company} dataMode={getDataMode()} />;
}
