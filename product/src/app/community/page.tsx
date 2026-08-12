import type { Metadata } from "next";
import { CommunityBoard } from "@/components/community/CommunityBoard";

export const metadata: Metadata = { title: "커뮤니티" };

export default function CommunityPage() {
  return (
    <div className="page-section community-page refresh-community-page">
      <div className="shell community-shell">
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">익명 커뮤니티</span>
          <h1>일하는 사람들의 확인 경험</h1>
          <p>혼자 묻기 어려웠던 질문과 확인 경험을 나눕니다. 현재 게시물은 화면 구조 확인용 더미 데이터입니다.</p>
        </div>
        <div className="mock-banner" role="status"><span>DEMO</span>검색과 분류만 화면에서 동작합니다. 작성·댓글·신고는 DB API 연결 전까지 제공하지 않습니다.</div>
        <CommunityBoard />
        <aside className="community-policy-note"><strong>커뮤니티 정보는 이렇게 구분합니다.</strong><p>게시물은 사용자 경험이며 공식 데이터나 법률 근거가 아닙니다. 익명 글의 작성자 식별정보는 공개 API에 포함하지 않습니다.</p></aside>
      </div>
    </div>
  );
}
