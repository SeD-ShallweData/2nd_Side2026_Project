import type { Metadata } from "next";
import { CompanySearch } from "@/components/company/CompanySearch";
import { DataModeNotice } from "@/components/company/DataModeNotice";
import { getCompanyDataMode } from "@/config/dataMode";
import { companyMessages } from "@/i18n/messages/company";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(companyMessages);
  return { title: m.page.metaTitle };
}

export default async function CompaniesPage() {
  const dataMode = getCompanyDataMode();
  const m = await getMessages(companyMessages);
  return (
    <div className="page-section search-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">{m.page.eyebrow}</span>
          <h1>{m.page.title}</h1>
          <p>{m.page.intro1}<br />{m.page.intro2}</p>
        </div>
        <DataModeNotice
          dataMode={dataMode}
          realMessage={m.page.dataModeReal}
          mockMessage={m.page.dataModeMock}
        />
        <CompanySearch />
      </div>
    </div>
  );
}
