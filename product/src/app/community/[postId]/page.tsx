import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostDetail } from "@/components/community/CommunityPostDetail";

export const metadata: Metadata = { title: "커뮤니티 게시글" };

interface PageProps {
  params: Promise<{ postId: string }>;
}

export default async function CommunityPostPage({ params }: PageProps) {
  const { postId } = await params;
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">커뮤니티</Link>
          <span aria-hidden="true">/</span>
          <span>게시글 상세</span>
        </div>
        <CommunityPostDetail postId={decodeURIComponent(postId)} />
      </div>
    </div>
  );
}
