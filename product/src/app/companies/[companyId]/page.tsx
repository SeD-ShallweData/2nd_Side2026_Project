import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompanyDetail } from "@/components/company/CompanyDetail";
import { getCompanyById } from "@/services/companyService";
import { getCompanyDataMode } from "@/config/dataMode";
import { format } from "@/i18n/defineMessages";
import { companyMessages } from "@/i18n/messages/company";
import { getMessages } from "@/i18n/server";

interface PageProps {
  params: Promise<{ companyId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const m = await getMessages(companyMessages);
  try {
    const { companyId } = await params;
    const company = await getCompanyById(decodeURIComponent(companyId));
    return { title: format(m.detailPage.metaTitle, { name: company.company_name }) };
  } catch {
    return { title: m.detailPage.metaFallback };
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
  return <CompanyDetail company={company} dataMode={getCompanyDataMode()} />;
}
