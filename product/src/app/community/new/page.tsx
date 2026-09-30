import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostForm } from "@/components/community/CommunityPostForm";
import { communityMessages } from "@/i18n/messages/community";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(communityMessages);
  return { title: m.newPage.metaTitle };
}

export default async function CommunityPostCreatePage() {
  const m = await getMessages(communityMessages);
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">{m.crumbs.community}</Link>
          <span aria-hidden="true">/</span>
          <span>{m.newPage.crumb}</span>
        </div>
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">{m.eyebrow}</span>
          <h1>{m.newPage.title}</h1>
          <p>{m.newPage.description}</p>
        </div>
        <CommunityPostForm />
      </div>
    </div>
  );
}
