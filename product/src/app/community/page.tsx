import type { Metadata } from "next";

export const metadata: Metadata = { title: "커뮤니티" };

const POSTS = [
  { tag: "입사 전 확인", title: "면접에서 임금 지급일은 어떻게 물어보면 좋을까요?", body: "계약서 작성 전에 지급일과 지급 방법을 자연스럽게 확인했던 경험을 나눠주세요.", author: "구직자", time: "12분 전", comments: 4 },
  { tag: "근로계약서", title: "포괄임금 조항을 받았을 때 먼저 확인할 항목", body: "기본급과 고정 연장수당이 분리되어 있는지부터 확인해보려고 합니다.", author: "익명 근로자", time: "35분 전", comments: 7 },
  { tag: "현장 안전", title: "보호구와 안전교육 여부를 확인한 경험을 나눠요", body: "첫 출근 전에 안전교육 일정과 보호구 지급 시점을 문의해도 괜찮았습니다.", author: "익명", time: "1시간 전", comments: 3 },
] as const;

export default function CommunityPage() {
  return (
    <div className="page-section community-page">
      <div className="shell community-shell">
        <div className="page-heading page-heading-left community-heading">
          <span className="eyebrow">팀원 구현 전 UI 기준</span>
          <h1>일하는 사람들의 확인 경험</h1>
          <p>실제 회사명과 연결할 수 있지만, 현재 게시물은 화면 구조를 확인하기 위한 명시된 더미 데이터입니다.</p>
        </div>
        <div className="mock-banner" role="status"><span>DEMO</span>게시물 작성·댓글·신고 기능은 커뮤니티 담당 개발본 통합 후 연결됩니다.</div>
        <div className="community-toolbar" aria-label="커뮤니티 분류 미리보기">
          <button className="is-active" type="button">전체</button>
          <button type="button">입사 전 확인</button>
          <button type="button">근로계약서</button>
          <button type="button">현장 안전</button>
          <button type="button" className="button button-dark" disabled>글쓰기 준비 중</button>
        </div>
        <section className="community-post-list" aria-label="더미 커뮤니티 게시물">
          {POSTS.map((post) => (
            <article className="community-post-card" key={post.title}>
              <div><span>{post.tag}</span><small>{post.author} · {post.time}</small></div>
              <h2>{post.title}</h2>
              <p>{post.body}</p>
              <strong>댓글 {post.comments}</strong>
            </article>
          ))}
        </section>
        <aside className="community-policy-note">
          <strong>커뮤니티 정보는 이렇게 구분합니다.</strong>
          <p>게시물은 사용자 경험이며 공식 데이터나 법률 근거가 아닙니다. 익명 글의 작성자 식별정보는 공개 API에 포함하지 않습니다.</p>
        </aside>
      </div>
    </div>
  );
}
