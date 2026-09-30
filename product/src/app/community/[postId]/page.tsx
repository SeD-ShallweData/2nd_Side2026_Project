import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostDetail } from "@/components/community/CommunityPostDetail";
import { communityMessages } from "@/i18n/messages/community";
import { getMessages } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = await getMessages(communityMessages);
  return { title: m.detailPage.metaTitle };
}

interface PageProps {
  params: Promise<{ postId: string }>;
}

export default async function CommunityPostPage({ params }: PageProps) {
  const { postId } = await params;
  const m = await getMessages(communityMessages);
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">{m.crumbs.community}</Link>
          <span aria-hidden="true">/</span>
          <span>{m.crumbs.detail}</span>
        </div>
        <CommunityPostDetail postId={decodeURIComponent(postId)} />
      </div>
    </div>
  );
}
