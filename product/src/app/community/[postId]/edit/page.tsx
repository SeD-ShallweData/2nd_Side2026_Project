import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostEditForm } from "@/components/community/CommunityPostEditForm";
import { communityMessages } from "@/i18n/messages/community";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(communityMessages);
  return { title: m.editPage.metaTitle };
}

interface PageProps {
  params: Promise<{ postId: string }>;
}

export default async function CommunityPostEditPage({ params }: PageProps) {
  const { postId } = await params;
  const decodedId = decodeURIComponent(postId);
  const m = await getMessages(communityMessages);
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">{m.crumbs.community}</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/community/${encodeURIComponent(decodedId)}`}>{m.crumbs.detail}</Link>
          <span aria-hidden="true">/</span>
          <span>{m.editPage.crumb}</span>
        </div>
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">{m.eyebrow}</span>
          <h1>{m.editPage.title}</h1>
          <p>{m.editPage.description}</p>
        </div>
        <CommunityPostEditForm postId={decodedId} />
      </div>
    </div>
  );
}
