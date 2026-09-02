import type { Metadata } from "next";
import Link from "next/link";
import { CommunityPostForm } from "@/components/community/CommunityPostForm";

export const metadata: Metadata = { title: "커뮤니티 글쓰기" };

export default function CommunityPostCreatePage() {
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="detail-breadcrumb">
          <Link href="/community">커뮤니티</Link>
          <span aria-hidden="true">/</span>
          <span>글쓰기</span>
        </div>
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">익명 커뮤니티</span>
          <h1>확인 경험을 나눠주세요</h1>
          <p>같은 상황을 겪는 사람에게 도움이 되는 확인 방법과 질문을 남겨주세요.</p>
        </div>
        <CommunityPostForm />
      </div>
    </div>
  );
}
