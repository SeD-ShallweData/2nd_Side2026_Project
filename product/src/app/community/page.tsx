import type { Metadata } from "next";
import { CommunityBoard } from "@/components/community/CommunityBoard";

export const metadata: Metadata = { title: "커뮤니티" };

export default function CommunityPage() {
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="page-heading community-heading">
          <span className="eyebrow">익명 커뮤니티</span>
          <h1>일하는 사람들의 확인 경험</h1>
          <p>혼자 묻기 어려웠던 질문과 확인 경험을 나눕니다. 일하는 사람들의 경험과 질문을 나누는 공간입니다.</p>
        </div>
        <div className="mock-banner" role="status"><span>안내</span>로그인 사용자는 게시글 작성과 신고를 이용할 수 있습니다.</div>
        <CommunityBoard />
      </div>
    </div>
  );
}
