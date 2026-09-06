import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostEditForm } from "@/components/community/CommunityPostEditForm";

export const metadata: Metadata = { title: "커뮤니티 게시글 수정" };

interface PageProps {
  params: Promise<{ postId: string }>;
}

export default async function CommunityPostEditPage({ params }: PageProps) {
  const { postId } = await params;
  const decodedId = decodeURIComponent(postId);
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">커뮤니티</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/community/${encodeURIComponent(decodedId)}`}>게시글 상세</Link>
          <span aria-hidden="true">/</span>
          <span>수정</span>
        </div>
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">익명 커뮤니티</span>
          <h1>게시글 수정</h1>
          <p>분류와 내용을 다시 확인하고 저장하세요. 바꾼 항목만 반영됩니다.</p>
        </div>
        <CommunityPostEditForm postId={decodedId} />
      </div>
    </div>
  );
}
