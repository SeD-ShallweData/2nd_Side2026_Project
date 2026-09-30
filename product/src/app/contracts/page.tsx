import type { Metadata } from "next";
import { ContractReviewPanel } from "@/components/contract/ContractReviewPanel";
import { getContractDataMode } from "@/config/dataMode";
import { contractMessages } from "@/i18n/messages/contract";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(contractMessages);
  return { title: m.page.metaTitle };
}

export default async function ContractsPage() {
  const dataMode = getContractDataMode();
  const m = (await getMessages(contractMessages)).page;
  return (
    <div className="page-section contract-page refresh-contract-page">
      <div className="shell narrow-shell">
        <div className="page-heading">
          <span className="eyebrow">{m.eyebrow}</span>
          <h1>{m.heading}</h1>
          <p>{m.intro}</p>
        </div>
        <div className={`mode-banner mode-banner-${dataMode}`} role="status">
          <span>{dataMode === "real" ? m.realBadge : m.demoBadge}</span>
          {dataMode === "real" ? m.realBanner : m.demoBanner}
        </div>
        <ContractReviewPanel dataMode={dataMode} />
      </div>
    </div>
  );
}
