import type { Metadata } from "next";
import { CommunityBoard } from "@/components/community/CommunityBoard";
import { communityMessages } from "@/i18n/messages/community";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(communityMessages);
  return { title: m.page.metaTitle };
}

export default async function CommunityPage() {
  const m = await getMessages(communityMessages);
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="page-heading community-heading">
          <span className="eyebrow">{m.eyebrow}</span>
          <h1>{m.page.title}</h1>
          <p>{m.page.description}</p>
        </div>
        <div className="mock-banner" role="status"><span>{m.page.bannerTag}</span>{m.page.banner}</div>
        <CommunityBoard />
      </div>
    </div>
  );
}
