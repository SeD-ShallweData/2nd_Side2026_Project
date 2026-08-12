"use client";

import { useMemo, useState } from "react";

const POSTS = [
  { category: "입사 전 확인", place: "서울 · 서비스업", title: "면접에서 임금 지급일은 어떻게 물어보면 좋을까요?", body: "계약서 작성 전에 지급일과 지급 방법을 자연스럽게 확인했던 경험을 나눠주세요.", author: "구직자", time: "12분 전", comments: 4, likes: 11 },
  { category: "근로계약서", place: "경기 · 제조업", title: "포괄임금 조항을 받았을 때 먼저 확인할 항목", body: "기본급과 고정 연장수당이 분리되어 있는지부터 확인해보려고 합니다.", author: "익명 근로자", time: "35분 전", comments: 7, likes: 8 },
  { category: "현장 안전", place: "인천 · 건설업", title: "보호구와 안전교육 여부를 확인한 경험을 나눠요", body: "첫 출근 전에 안전교육 일정과 보호구 지급 시점을 문의해도 괜찮았습니다.", author: "익명", time: "1시간 전", comments: 3, likes: 6 },
  { category: "임금", place: "부산 · 운수업", title: "급여일이 달라졌을 때 어떤 기록을 남기셨나요?", body: "문자와 입금내역 외에 함께 보관하면 좋은 자료가 궁금합니다.", author: "근로자", time: "2시간 전", comments: 5, likes: 9 },
] as const;

const CATEGORIES = ["전체", "입사 전 확인", "근로계약서", "현장 안전", "임금"] as const;

export function CommunityBoard() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("전체");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("ko-KR");
    return POSTS.filter((post) => (category === "전체" || post.category === category) && (!term || `${post.title} ${post.body} ${post.place}`.toLocaleLowerCase("ko-KR").includes(term)));
  }, [category, query]);

  return (
    <>
      <div className="community-interaction-row">
        <div className="community-toolbar" aria-label="커뮤니티 분류">
          {CATEGORIES.map((item) => <button key={item} className={category === item ? "is-active" : ""} type="button" onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <label className="community-search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="게시글 검색" /></label>
      </div>
      <section className="community-post-list" aria-label="더미 커뮤니티 게시물">
        {filtered.map((post) => (
          <article className="community-post-card" key={post.title}>
            <div><span>{post.category}</span><small>{post.place} · {post.author} · {post.time}</small></div>
            <h2>{post.title}</h2><p>{post.body}</p><strong>공감 {post.likes}　댓글 {post.comments}</strong>
          </article>
        ))}
        {filtered.length === 0 ? <div className="community-empty">조건에 맞는 DEMO 게시물이 없습니다.</div> : null}
      </section>
    </>
  );
}
